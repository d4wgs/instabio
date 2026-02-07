// Firebase (CDN modules)
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  runTransaction,
  serverTimestamp,
  increment,
  getDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

// --- Your Firebase config (from your snippet) ---
const firebaseConfig = {
  apiKey: "AIzaSyC6JfYTZHeoqxNk5Ie5htO3wu6FLtuGYeM",
  authDomain: "instagram-bio-be1ce.firebaseapp.com",
  projectId: "instagram-bio-be1ce",
  storageBucket: "instagram-bio-be1ce.firebasestorage.app",
  messagingSenderId: "496141083851",
  appId: "1:496141083851:web:e2743c1ee3757a050ba74e",
  measurementId: "G-VVVK8RPB5B"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// -----------------------------------------------------
// Badge pools (your selected list)
// -----------------------------------------------------
const BADGES = [
  // Morning
  "Morning Shift",
  "Coffee Break",
  "First Scroll",
  "Sunrise Check-In",
  "Commute Click",

  // Night / Late Night
  "Midnight Shift",
  "Overnight Shift",
  "Lights Out",
  "Last Scroll",
  "2AM Check-In",
  "Ghost Mode",

  // Mobile
  "Pocket Visitor",
  "Low Signal-High Intent",
  "Notification Check",
  "Charging Soon",

  // Desktop
  "Second Monitor",
  "Keyboard Confirmed",
  "Cursor Operator",
  "Full-Screen Visitor",

  // Time on page (used as tags, but included in global pool to keep variety)
  "Drive-By",
  "In & Out",
  "Quick Scan",
  "Brief Visit",
  "Stayed a Minute",
  "Verified Interest",
  "AFK",

  // Clicks today (also used as tags)
  "Single Visit",
  "Second Look",
  "Came Back?!",
  "Repeat Visitor",
  "Monitoring",
  "High Frequency",
  "Verified Checker"
];

// -----------------------------------------------------
// Helpers: category tags (computed locally)
// -----------------------------------------------------
function getTimeOfDayTag() {
  const h = new Date().getHours();
  if (h >= 5 && h < 12) return "Morning";
  if (h >= 12 && h < 18) return "Day";
  if (h >= 18 && h < 23) return "Night";
  return "Late Night";
}

function getDeviceTag() {
  // Simple + reliable enough: touch + small width implies mobile
  const isTouch = ("ontouchstart" in window) || navigator.maxTouchPoints > 0;
  const isSmall = window.matchMedia && window.matchMedia("(max-width: 720px)").matches;
  return (isTouch && isSmall) ? "Mobile" : "Desktop";
}

function getTodayKey() {
  // YYYY-MM-DD for daily counters (safe as Firestore map key)
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function pickClicksTodayTag(clicks) {
  if (clicks <= 1) return "Single Visit";
  if (clicks === 2) return "Second Look";
  if (clicks === 3) return "Came Back?!";
  if (clicks <= 6) return "Monitoring";
  if (clicks <= 12) return "High Frequency";
  return "Verified Checker";
}

function pickTimeOnPageTag(seconds) {
  if (seconds < 6) return "Drive-By";
  if (seconds < 15) return "In & Out";
  if (seconds < 30) return "Quick Scan";
  if (seconds < 60) return "Brief Visit";
  if (seconds < 120) return "Stayed a Minute";
  if (seconds < 240) return "Verified Interest";
  return "AFK";
}

// -----------------------------------------------------
// Unique counting + main badge assignment (transaction)
// -----------------------------------------------------
async function ensureUniqueAndBadge() {
  // 1) Sign in anonymously (gives stable uid for this browser profile)
  const cred = await signInAnonymously(auth);
  const uid = cred.user.uid;

  const statsRef = doc(db, "stats", "global");
  const visitorRef = doc(db, "visitors", uid);

  const todayKey = getTodayKey();
  const dayField = `dailyClicks.${todayKey}`;

  const result = await runTransaction(db, async (tx) => {
    const [statsSnap, visitorSnap] = await Promise.all([
      tx.get(statsRef),
      tx.get(visitorRef)
    ]);

    const stats = statsSnap.exists() ? statsSnap.data() : { uniqueVisitors: 0, badgeCursor: 0 };

    let isNew = false;
    let mainBadge = null;

    // If visitor doc does not exist: first time we have EVER seen this uid
    if (!visitorSnap.exists()) {
      isNew = true;

      const cursor = typeof stats.badgeCursor === "number" ? stats.badgeCursor : 0;
      mainBadge = BADGES[cursor % BADGES.length];

      tx.set(visitorRef, {
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        mainBadge,
        totalSeconds: 0,
        dailyClicks: { [todayKey]: 1 },
        deviceFirstSeen: getDeviceTag()
      });

      tx.update(statsRef, {
        uniqueVisitors: increment(1),
        badgeCursor: increment(1)
      });
    } else {
      // Returning visitor: do not increment uniqueVisitors
      const v = visitorSnap.data();
      mainBadge = v.mainBadge || "Silent Scroller";

      // Increment today's click count + update lastSeen
      tx.update(visitorRef, {
        lastSeenAt: serverTimestamp(),
        [dayField]: increment(1)
      });
    }

    // Read back the latest stats (transaction returns our computed next values)
    const nextUniqueVisitors = isNew ? (stats.uniqueVisitors + 1) : stats.uniqueVisitors;

    // Also return today's click count after increment (estimate; we’ll re-fetch for accuracy below)
    const assumedClicks = visitorSnap.exists()
      ? ((visitorSnap.data().dailyClicks && visitorSnap.data().dailyClicks[todayKey]) || 0) + 1
      : 1;

    return { uid, mainBadge, uniqueVisitors: nextUniqueVisitors, clicksToday: assumedClicks };
  });

  return result;
}

// -----------------------------------------------------
// Time on page tracking (best-effort)
// -----------------------------------------------------
let sessionStart = null;
let currentUid = null;

async function flushTimeOnPage() {
  if (!currentUid || sessionStart == null) return;

  const seconds = Math.max(0, Math.round((Date.now() - sessionStart) / 1000));
  sessionStart = Date.now(); // reset anchor

  // Avoid spamming tiny increments
  if (seconds < 2) return;

  try {
    const visitorRef = doc(db, "visitors", currentUid);
    await updateDoc(visitorRef, { totalSeconds: increment(seconds) });
  } catch {
    // ignore (page closing, network, etc.)
  }
}

// -----------------------------------------------------
// UI updates
// -----------------------------------------------------
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function renderTags(uid) {
  const todayKey = getTodayKey();
  const visitorRef = doc(db, "visitors", uid);
  const snap = await getDoc(visitorRef);
  const v = snap.exists() ? snap.data() : {};

  const timeOfDay = getTimeOfDayTag();
  const device = getDeviceTag();

  const clicksToday = (v.dailyClicks && v.dailyClicks[todayKey]) ? v.dailyClicks[todayKey] : 1;
  const clicksTag = pickClicksTodayTag(clicksToday);

  const totalSeconds = typeof v.totalSeconds === "number" ? v.totalSeconds : 0;
  const timeTag = pickTimeOnPageTag(totalSeconds);

  setText("viewerTags", `${timeOfDay} • ${device} • ${clicksTag} • ${timeTag}`);
}

// Your existing launch timer logic (kept)
function updateTimeSinceLaunch() {
  const launchDate = new Date(Date.UTC(2024, 9, 29, 21 + 4, 38, 0)); // Oct = 9, EST = UTC+4

  function getTimeDiffComponents(now, then) {
    const diffMs = now - then;
    const seconds = Math.floor(diffMs / 1000);
    let remaining = seconds;

    const y = Math.floor(remaining / (365.25 * 24 * 60 * 60));
    remaining -= y * 365.25 * 24 * 60 * 60;

    const mo = Math.floor(remaining / (30.44 * 24 * 60 * 60));
    remaining -= mo * 30.44 * 24 * 60 * 60;

    const d = Math.floor(remaining / (24 * 60 * 60));
    remaining -= d * 24 * 60 * 60;

    const h = Math.floor(remaining / 3600);
    remaining -= h * 3600;

    const m = Math.floor(remaining / 60);
    const s = Math.floor(remaining % 60);

    return { y, mo, d, h, m, s };
  }

  function render() {
    const now = new Date();
    const { y, mo, d, h, m, s } = getTimeDiffComponents(now, launchDate);
    const timerSpan = document.getElementById("timeSinceLaunch");
    if (timerSpan) timerSpan.innerText = `${y}y ${mo}mo ${d}d ${h}h ${m}m ${s}s`;
  }

  function scheduleRender() {
    render();
    setTimeout(scheduleRender, 1000 - (Date.now() % 1000));
  }

  scheduleRender();
}

// -----------------------------------------------------
// Boot
// -----------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const { uid, mainBadge, uniqueVisitors } = await ensureUniqueAndBadge();

    currentUid = uid;
    sessionStart = Date.now();

    // Update UI
    setText("viewCount", String(uniqueVisitors));
    setText("viewerBadge", mainBadge);
    setText("marqueeBadge", `badge: ${mainBadge}`);

    await renderTags(uid);

    // Track time on page (best-effort)
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushTimeOnPage();
      if (document.visibilityState === "visible") sessionStart = Date.now();
    });

    window.addEventListener("beforeunload", () => {
      // best-effort flush (may not always complete)
      flushTimeOnPage();
    });

    updateTimeSinceLaunch();
  } catch (e) {
    console.error(e);
    setText("viewCount", "N/A");
    setText("viewerBadge", "N/A");
    setText("viewerTags", "N/A");
    setText("marqueeBadge", "offline");
    updateTimeSinceLaunch();
  }
});
