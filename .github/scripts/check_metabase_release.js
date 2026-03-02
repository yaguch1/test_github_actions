const https = require('https');

// Helper to make HTTP requests
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`Request failed with status ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repoOwner = process.env.GITHUB_REPOSITORY.split('/')[0];
  const repoName = process.env.GITHUB_REPOSITORY.split('/')[1];
  const rotationMembers = process.env.ROTATION_MEMBERS ? process.env.ROTATION_MEMBERS.split(',').map(m => m.trim()) : [];
  const isDryRun = process.argv.includes('--dry-run');

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (rotationMembers.length === 0) console.warn('ROTATION_MEMBERS is empty. Issues will be unassigned.');
  if (isDryRun) console.log('--- DRY RUN MODE: No issues will be created or updated ---');

  // 1. Fetch Latest Metabase Release
  console.log('Fetching latest Metabase release...');
  const metabaseRelease = await request({
    hostname: 'api.github.com',
    path: '/repos/metabase/metabase/releases/latest',
    method: 'GET',
    headers: { 'User-Agent': 'node.js' }
  });

  const latestVersion = metabaseRelease.tag_name; // e.g., v0.58.5
  console.log(`Latest version: ${latestVersion}`);

  // Parse version
  const versionMatch = latestVersion.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!versionMatch) {
    console.error(`Could not parse version ${latestVersion}`);
    return;
  }
  const major = versionMatch[1];
  const minor = versionMatch[2];
  const patch = versionMatch[3];
  const versionMajorMinor = `v${major}.${minor}`; // v0.58
  const versionMajorMinorX = `${versionMajorMinor}.x`; // v0.58.x

  const headers = {
    'User-Agent': 'node.js',
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json'
  };

  // 2. Check if Child Issue already exists
  const searchChildQuery = `repo:${repoOwner}/${repoName} is:issue label:metabase-update-issue "Update Metabase to ${latestVersion}"`;
  const childIssues = await request({
    hostname: 'api.github.com',
    path: `/search/issues?q=${encodeURIComponent(searchChildQuery)}`,
    method: 'GET',
    headers
  });

  if (childIssues.total_count > 0) {
    console.log(`Issue for ${latestVersion} already exists. Exiting.`);
    return;
  }

  // 3. Find or Create Parent Issue
  const searchParentQuery = `repo:${repoOwner}/${repoName} is:issue "Metabase Release ${versionMajorMinorX}"`;
  const parentIssues = await request({
    hostname: 'api.github.com',
    path: `/search/issues?q=${encodeURIComponent(searchParentQuery)}`,
    method: 'GET',
    headers
  });

  let parentIssueNumber;
  if (parentIssues.total_count > 0) {
    parentIssueNumber = parentIssues.items[0].number;
    console.log(`Found Parent Issue #${parentIssueNumber}`);
  } else {
    if (isDryRun) {
      console.log(`[Dry Run] Would create Parent Issue for ${versionMajorMinorX}`);
      parentIssueNumber = "DRY-RUN-PARENT-ID";
    } else {
      console.log(`Creating Parent Issue for ${versionMajorMinorX}...`);
      const newParent = await request({
        hostname: 'api.github.com',
        path: `/repos/${repoOwner}/${repoName}/issues`,
        method: 'POST',
        headers
      }, {
        title: `Metabase Release ${versionMajorMinorX}`,
        body: `## Release Tracking for ${versionMajorMinorX}\n\n- [ ] Initial Release` // Initialize list
      });
      parentIssueNumber = newParent.number;
      console.log(`Created Parent Issue #${parentIssueNumber}`);
    }
  }

  // 4. Calculate Assignee
  let nextAssignee = null;
  if (rotationMembers.length > 0) {
    // Find last created issue with label metabase-update-issue to see who was assigned
    // We sort by created desc to get the very last one
    const lastIssueQuery = `repo:${repoOwner}/${repoName} is:issue label:metabase-update-issue sort:created-desc`;
    const lastIssues = await request({
      hostname: 'api.github.com',
      path: `/search/issues?q=${encodeURIComponent(lastIssueQuery)}&per_page=1`,
      method: 'GET',
      headers
    });

    let lastAssignee = null;
    if (lastIssues.total_count > 0 && lastIssues.items[0].assignee) {
      lastAssignee = lastIssues.items[0].assignee.login;
    }

    if (lastAssignee) {
      const idx = rotationMembers.indexOf(lastAssignee);
      if (idx === -1 || idx === rotationMembers.length - 1) {
        nextAssignee = rotationMembers[0];
      } else {
        nextAssignee = rotationMembers[idx + 1];
      }
    } else {
      nextAssignee = rotationMembers[0];
    }
  }

  // 5. Create Child Issue
  if (isDryRun) {
    console.log(`[Dry Run] Would create Child Issue: "Update Metabase to ${latestVersion}"`);
    console.log(`[Dry Run] Would assign to: ${nextAssignee || 'No one'}`);
    console.log(`[Dry Run] Would register as sub-issue of Parent Issue #${parentIssueNumber}`);
  } else {
    console.log(`Creating Child Issue for ${latestVersion}...`);
    const newChild = await request({
      hostname: 'api.github.com',
      path: `/repos/${repoOwner}/${repoName}/issues`,
      method: 'POST',
      headers
    }, {
      title: `Update Metabase to ${latestVersion}`,
      body: `New version ${latestVersion} is available.\n\n[Release Notes](${metabaseRelease.html_url})\n\nParent Issue: #${parentIssueNumber}`,
      labels: ['metabase-update-issue'],
      assignees: nextAssignee ? [nextAssignee] : []
    });
    console.log(`Created Child Issue #${newChild.number} assigned to ${nextAssignee}`);

    // 6. Register Child Issue as Sub-issue of Parent
    console.log(`Registering #${newChild.number} as sub-issue of #${parentIssueNumber}...`);
    await request({
      hostname: 'api.github.com',
      path: `/repos/${repoOwner}/${repoName}/issues/${parentIssueNumber}/sub_issues`,
      method: 'POST',
      headers
    }, {
      sub_issue_id: newChild.number
    });
    console.log('Sub-issue registered.');
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
