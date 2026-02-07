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

/**
 * Badge pools by EST time bucket.
 * These are only used when the visitor is NEW (first time ever for that Firebase uid).
 */
const BADGE_POOLS = {
  morning: ["Morning Shift", "Coffee Break", "First Scroll", "Sunrise Check-In", "Commute Click"],
  night: ["Midnight Shift", "Overnight Shift", "Lights Out", "Last Scroll", "2AM Check-In", "Ghost Mode"],

  // Optional buckets (kept small on purpose); you can expand if you want
  day: ["Coffee Break", "First Scroll", "Commute Click"],
  late: ["Ghost Mode", "2AM Check-In", "Lights Out"]
};

function getTodayKey() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Returns hour in America/New_York (0-23), independent of viewer’s local timezone. */
function getNYHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false
  }).formatToParts(new Date());

  const hourStr = parts.find(p => p.type === "hour")?.value ?? "0";
  return parseInt(hourStr, 10);
}

function getTimeBucketNY() {
  const h = getNYHour();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 18) return "day";
  if (h >= 18 && h < 24) return "night";
  return "late";
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

async function ensureUniqueAndBadge() {
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

    const stats = statsSnap.exists()
      ? statsSnap.data()
      : { uniqueVisitors: 0 };

    let isNew = false;
    let mainBadge = null;

    // We now keep a separate cursor PER bucket (morning/day/night/late)
    const bucket = getTimeBucketNY();
    const pool = BADGE_POOLS[bucket] || BADGE_POOLS.night;
    const cursorField = `badgeCursor_${bucket}`;

    if (!visitorSnap.exists()) {
      isNew = true;

      const cursor = (typeof stats[cursorField] === "number") ? stats[cursorField] : 0;
      mainBadge = pool[cursor % pool.length];

      tx.set(visitorRef, {
        createdAt: serverTimestamp(),
        lastSeenAt: serverTimestamp(),
        mainBadge,
        badgeBucket: bucket,
        totalSeconds: 0,
        dailyClicks: { [todayKey]: 1 }
      });

      tx.update(statsRef, {
        uniqueVisitors: increment(1),
        [cursorField]: increment(1)
      });
    } else {
      const v = visitorSnap.data();
      mainBadge = v.mainBadge || "Silent Scroller";

      tx.update(visitorRef, {
        lastSeenAt: serverTimestamp(),
        [dayField]: increment(1)
      });
    }

    const assumedClicks = visitorSnap.exists()
      ? ((visitorSnap.data().dailyClicks && visitorSnap.data().dailyClicks[todayKey]) || 0) + 1
      : 1;

    const nextUniqueVisitors = isNew ? ((stats.uniqueVisitors || 0) + 1) : (stats.uniqueVisitors || 0);

    return { uid, mainBadge, uniqueVisitors: nextUniqueVisitors, clicksToday: assumedClicks };
  });

  return result;
}

let sessionStart = null;
let currentUid = null;

let baseTotalSeconds = 0;
let clicksTodayCached = 1;

// Active-only time accumulator (this session, visible-only)
let activeSessionSeconds = 0;
let isVisibleRunning = true;

async function flushTimeOnPage() {
  if (!currentUid) return;

  if (isVisibleRunning && sessionStart != null) {
    const elapsed = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
    if (elapsed > 0) {
      activeSessionSeconds += elapsed;
      sessionStart = Date.now();
    }
  }

  if (activeSessionSeconds < 2) return;

  const toFlush = activeSessionSeconds;
  activeSessionSeconds = 0;

  try {
    const visitorRef = doc(db, "visitors", currentUid);
    await updateDoc(visitorRef, { totalSeconds: increment(toFlush) });
    baseTotalSeconds += toFlush;
  } catch {
    // ignore
  }
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

async function renderTags(uid) {
  const todayKey = getTodayKey();
  const visitorRef = doc(db, "visitors", uid);
  const snap = await getDoc(visitorRef);
  const v = snap.exists() ? snap.data() : {};

  baseTotalSeconds = (typeof v.totalSeconds === "number") ? v.totalSeconds : 0;

  if (v.dailyClicks && typeof v.dailyClicks[todayKey] === "number") {
    clicksTodayCached = v.dailyClicks[todayKey];
  }

  updateTagsLive();
}

function updateTagsLive() {
  const liveElapsed =
    (isVisibleRunning && sessionStart != null)
      ? Math.max(0, Math.floor((Date.now() - sessionStart) / 1000))
      : 0;

  const totalActiveSeconds = baseTotalSeconds + activeSessionSeconds + liveElapsed;

  const timeTag = pickTimeOnPageTag(totalActiveSeconds);
  const clicksTag = pickClicksTodayTag(clicksTodayCached);

  setText("viewerTags", `${clicksTag} • ${timeTag}`);
}

function updateTimeSinceLaunch() {
  const launchDate = new Date(Date.UTC(2024, 9, 29, 21 + 4, 38, 0));

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

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const { uid, mainBadge, uniqueVisitors, clicksToday } = await ensureUniqueAndBadge();

    currentUid = uid;
    sessionStart = Date.now();

    clicksTodayCached = clicksToday;

    setText("viewCount", String(uniqueVisitors));
    setText("viewerBadge", mainBadge);

    const statsSnap = await getDoc(doc(db, "stats", "global"));
    if (statsSnap.exists() && typeof statsSnap.data().uniqueVisitors === "number") {
      setText("viewCount", String(statsSnap.data().uniqueVisitors));
    }

    await renderTags(uid);

    setInterval(updateTagsLive, 1000);

    setInterval(async () => {
      await flushTimeOnPage();
      updateTagsLive();
    }, 15000);

    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "hidden") {
        if (isVisibleRunning && sessionStart != null) {
          const elapsed = Math.max(0, Math.floor((Date.now() - sessionStart) / 1000));
          activeSessionSeconds += elapsed;
        }
        isVisibleRunning = false;
        sessionStart = null;

        await flushTimeOnPage();
        updateTagsLive();
      }

      if (document.visibilityState === "visible") {
        isVisibleRunning = true;
        sessionStart = Date.now();
        updateTagsLive();
      }
    });

    // Keep only ONE pagehide listener (you had it duplicated)
    window.addEventListener("pagehide", () => {
      flushTimeOnPage();
    });

    window.addEventListener("beforeunload", () => {
      flushTimeOnPage();
    });

    updateTimeSinceLaunch();
  } catch (e) {
    console.error(e);
    setText("viewCount", "N/A");
    setText("viewerBadge", "N/A");
    setText("viewerTags", "N/A");
    updateTimeSinceLaunch();
  }
});
