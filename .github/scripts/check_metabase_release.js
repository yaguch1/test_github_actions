const https = require('https');
const fs = require('fs');
const path = require('path');

// GitHub APIへのHTTPリクエストを行うヘルパー
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
            reject(new Error(`レスポンスのJSONパースに失敗しました: ${data}`));
          }
        } else {
          reject(new Error(`ステータス ${res.statusCode} でリクエストが失敗しました: ${data}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Metabaseの最新リリース情報を取得する
// 戻り値: { latestVersion: string, versionMajorMinorX: string, releaseUrl: string }
async function fetchLatestMetabaseRelease() {
  console.log('Metabaseの最新リリースを取得しています...');
  const release = await request({
    hostname: 'api.github.com',
    path: '/repos/metabase/metabase/releases/latest',
    method: 'GET',
    headers: { 'User-Agent': 'node.js' }
  });

  const metabaseLatestVersion = release.tag_name; // 例: v0.58.5
  console.log(`最新バージョン: ${metabaseLatestVersion}`);

  const versionMatch = metabaseLatestVersion.match(/^v(\d+)\.(\d+)\.(\d+)$/);
  if (!versionMatch) {
    throw new Error(`バージョンのパースに失敗しました: ${metabaseLatestVersion}`);
  }

  const [, major, minor] = versionMatch;
  const versionMajorMinorX = `v${major}.${minor}.x`; // 例: v0.58.x

  return { metabaseLatestVersion, versionMajorMinorX, releaseUrl: release.html_url };
}

// 指定バージョンの子Issueが既に存在するか確認する
// 戻り値: boolean
async function checkChildIssueExists(metabaseLatestVersion, { headers, repoOwner, repoName }) {
  const query = `repo:${repoOwner}/${repoName} is:issue in:title label:metabase-update-issue "Update Metabase to ${metabaseLatestVersion}"`;
  const result = await request({
    hostname: 'api.github.com',
    path: `/search/issues?q=${encodeURIComponent(query)}`,
    method: 'GET',
    headers
  });
  return result.total_count > 0;
}

// 親Issueを検索し、なければ新規作成する
// 戻り値: number（親IssueのIssue番号）
async function findOrCreateParentIssue(versionMajorMinorX, { headers, repoOwner, repoName, isDryRun }) {
  const query = `repo:${repoOwner}/${repoName} is:issue in:title "Metabase Release ${versionMajorMinorX}"`;
  const result = await request({
    hostname: 'api.github.com',
    path: `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc`,
    method: 'GET',
    headers
  });

  if (result.total_count > 0) {
    const number = result.items[0].number;
    console.log(`既存の親Issue #${number} を使用します`);
    return number;
  }

  if (isDryRun) {
    console.log(`[Dry Run] 親Issue「Metabase Release ${versionMajorMinorX}」を作成します`);
    return 'DRY-RUN-PARENT-ID';
  }

  console.log(`親Issue「Metabase Release ${versionMajorMinorX}」を作成します...`);
  const newParent = await request({
    hostname: 'api.github.com',
    path: `/repos/${repoOwner}/${repoName}/issues`,
    method: 'POST',
    headers
  }, {
    title: `Metabase Release ${versionMajorMinorX}`,
    body: `Metabaseのバージョンアップを行い、最新のバージョンに追従する。\n\nhttps://github.com/metabase/metabase/releases`
  });
  console.log(`親Issue #${newParent.number} を作成しました`);
  return newParent.number;
}

// 輪番で次の担当者を決める
// 戻り値: string | null（GitHubユーザー名。対象者なしの場合はnull）
async function calculateNextAssignee(rotationMembers, { headers, repoOwner, repoName }) {
  if (rotationMembers.length === 0) return null;

  // metabase-update-issueラベルが付いた直近のIssueから前回の担当者を確認する
  const query = `repo:${repoOwner}/${repoName} is:issue label:metabase-update-issue`;
  const result = await request({
    hostname: 'api.github.com',
    path: `/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=1`,
    method: 'GET',
    headers
  });

  const lastAssignee = result.total_count > 0 && result.items[0].assignee
    ? result.items[0].assignee.login
    : null;

  if (!lastAssignee) return rotationMembers[0];

  const idx = rotationMembers.indexOf(lastAssignee);
  if (idx === -1 || idx === rotationMembers.length - 1) return rotationMembers[0];
  return rotationMembers[idx + 1];
}

// 環境変数からコンテキストを構築する
// 戻り値: { headers: object, repoOwner: string, repoName: string, isDryRun: boolean }
function buildContext() {
  // GITHUB_TOKEN: ワークフローの permissions で issues: write が必要
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN が設定されていません');

  // GITHUB_REPOSITORY: GitHubActionsが自動設定する変数。
  // 形式: "owner/repo"（例: armg/dietplus-terraform）
  const [repoOwner, repoName] = process.env.GITHUB_REPOSITORY.split('/');
  const isDryRun = process.argv.includes('--dry-run');
  const headers = {
    'User-Agent': 'node.js',
    'Authorization': `token ${token}`,
    'Accept': 'application/vnd.github+json',
    'Content-Type': 'application/json'
  };

  return { headers, repoOwner, repoName, isDryRun };
}

// JSONファイルから輪番メンバーを取得する
// メンバーの追加・削除は .github/metabase-rotation-members.json を編集してPRを出す
// 戻り値: string[]
function parseRotationMembers() {
  const filePath = path.join(__dirname, '../metabase-rotation-members.json');
  const members = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (members.length === 0) console.warn('metabase-rotation-members.json が空です。Issueは未割当になります。');
  return members;
}

// 子Issueを作成してSub-issueとして親Issueに紐づける
async function createChildIssue({ metabaseLatestVersion, releaseUrl, parentIssueNumber, assignee, isDryRun }, { headers, repoOwner, repoName }) {
  if (isDryRun) {
    console.log(`[Dry Run] 子Issue「Update Metabase to ${metabaseLatestVersion}」を作成します`);
    console.log(`[Dry Run] 担当者: ${assignee || '未割当'}`);
    console.log(`[Dry Run] 親Issue #${parentIssueNumber} のSub-issueとして登録します`);
    return;
  }

  console.log(`子Issue「Update Metabase to ${metabaseLatestVersion}」を作成します...`);
  const newChild = await request({
    hostname: 'api.github.com',
    path: `/repos/${repoOwner}/${repoName}/issues`,
    method: 'POST',
    headers
  }, {
    title: `Update Metabase to ${metabaseLatestVersion}`,
    body: `${metabaseLatestVersion} がリリースされました。\n\n[リリースノート](${releaseUrl})\n\n親Issue: #${parentIssueNumber}`,
    labels: ['metabase-update-issue'],
    assignees: assignee ? [assignee] : []
  });
  console.log(`子Issue #${newChild.number} を作成しました（担当: ${assignee}）`);

  console.log(`#${newChild.number} を親Issue #${parentIssueNumber} のSub-issueとして登録します...`);
  await request({
    hostname: 'api.github.com',
    path: `/repos/${repoOwner}/${repoName}/issues/${parentIssueNumber}/sub_issues`,
    method: 'POST',
    headers
  }, {
    sub_issue_id: newChild.id
  });
  console.log('Sub-issueとして登録しました');
}

async function main() {
  const githubConfig = buildContext();
  const rotationMembers = parseRotationMembers();

  if (githubConfig.isDryRun) console.log('--- DRY RUN MODE: Issueの作成・更新は行いません ---');

  const { metabaseLatestVersion, versionMajorMinorX, releaseUrl } = await fetchLatestMetabaseRelease();

  if (await checkChildIssueExists(metabaseLatestVersion, githubConfig)) {
    console.log(`${metabaseLatestVersion} のIssueは既に存在します。終了します。`);
    return;
  }

  const parentIssueNumber = await findOrCreateParentIssue(versionMajorMinorX, githubConfig);
  const assignee = await calculateNextAssignee(rotationMembers, githubConfig);
  await createChildIssue({ metabaseLatestVersion, releaseUrl, parentIssueNumber, assignee, isDryRun: githubConfig.isDryRun }, githubConfig);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
