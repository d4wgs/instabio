async function getUniqueViews() {
    // Check if the user has a unique ID in localStorage
    if (!localStorage.getItem('uniqueUserID')) {
      // Generate a unique ID and store it
      localStorage.setItem('uniqueUserID', Date.now().toString() + Math.random().toString(36));
      
      // If a new user, increment the view count on JSONBin
      await fetch(`https://api.jsonbin.io/v3/b/6720fd52ad19ca34f8c08e7a`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': '$2a$10$52X.s5uepMV4sgD8ulXgbuCpbmswGD7xcHuVHXLW/dnkdcYFEq8J.'
        },
        body: JSON.stringify({ uniqueViews: await fetchViewCount() + 1 })
      });
    }
    
    // Display updated view count
    document.getElementById('viewCount').innerText = await fetchViewCount();
  }

  async function fetchViewCount() {
    const response = await fetch(`https://api.jsonbin.io/v3/b/6720fd52ad19ca34f8c08e7a/latest`, {
      headers: { 'X-Master-Key': '$2a$10$52X.s5uepMV4sgD8ulXgbuCpbmswGD7xcHuVHXLW/dnkdcYFEq8J.' }
    });
    const data = await response.json();
    return data.record.uniqueViews;
  }

  document.addEventListener("DOMContentLoaded", function() {
    getUniqueViews();
  });