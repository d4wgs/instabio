async function fetchViewCount() {
  try {
    const response = await fetch('https://api.jsonbin.io/v3/b/6720fd52ad19ca34f8c08e7a/latest', {
      headers: {
        'X-Master-Key': '$2a$10$52X.s5uepMV4sgD8ulXgbuCpbmswGD7xcHuVHXLW/dnkdcYFEq8J.'
      }
    });
    const data = await response.json();
    return data.record.uniqueViews;
  } catch (error) {
    console.error("Error fetching view count:", error);
    return "error";
  }
}

async function updateUniqueView() {
  try {
    let currentViews = await fetchViewCount();

    if (typeof currentViews === "number") {
      if (!localStorage.getItem('SK_uniqueUserID')) {
        const uniqueID = Date.now().toString() + Math.random().toString(36);
        localStorage.setItem('SK_uniqueUserID', uniqueID);

        await fetch('https://api.jsonbin.io/v3/b/6720fd52ad19ca34f8c08e7a', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'X-Master-Key': '$2a$10$52X.s5uepMV4sgD8ulXgbuCpbmswGD7xcHuVHXLW/dnkdcYFEq8J.'
          },
          body: JSON.stringify({ uniqueViews: currentViews + 1 })
        });

        currentViews++;
      }

      document.getElementById('viewCount').innerText = currentViews;
    } else {
      document.getElementById('viewCount').innerText = "N/A";
    }
  } catch (error) {
    console.error("Error updating view count:", error);
    document.getElementById('viewCount').innerText = "error";
  }
}

function updateTimeSinceLaunch() {
  const launchDate = new Date(Date.UTC(2024, 9, 29, 21 + 4, 38, 0)); // Oct = 9 (zero-indexed), EST = UTC+4


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
    if (timerSpan) {
      timerSpan.innerText = `${y}y ${mo}mo ${d}d ${h}h ${m}m ${s}s`;
    }
  }

  function scheduleRender() {
    render();
    setTimeout(scheduleRender, 1000 - (Date.now() % 1000));
  }

  scheduleRender();
}

document.addEventListener("DOMContentLoaded", () => {
  updateUniqueView();
  updateTimeSinceLaunch();
});
