'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline/promises');
const core = require('./lib/setup-core.cjs');
const protocol = require('./lib/template-protocol.cjs');

const ROOT = path.resolve(__dirname, '..');
const REPOSITORY = core.REPOSITORY;
const OWNER = core.OWNER;
const REPO_URL = `https://github.com/${REPOSITORY}`;
const LINKS = Object.freeze({
  environments: `${REPO_URL}/settings/environments`,
  branches: `${REPO_URL}/settings/branches`,
  variables: `${REPO_URL}/settings/variables/actions`,
  secrets: `${REPO_URL}/settings/secrets/actions`,
  workflow: `${REPO_URL}/actions/workflows/publish-catalog.yml`,
});

class SetupBlocked extends Error {
  constructor(code, link) { super(code); this.code = code; this.link = link; }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // stderr may contain auth/network detail. Never surface it from setup code.
    const error = new SetupBlocked(options.code ?? 'COMMAND_FAILED');
    const match = /HTTP (\d{3})/i.exec(result.stderr ?? '');
    if (match) error.httpStatus = Number(match[1]);
    throw error;
  }
  return result.stdout.trim();
}

function gh(args, options = {}) { return run('gh', args, options); }
function ghJson(args) {
  try { return JSON.parse(gh(['api', ...args])); }
  catch (error) {
    if (error instanceof SetupBlocked) throw error;
    throw new SetupBlocked('GITHUB_RESPONSE_INVALID');
  }
}

function authCheck() {
  try {
    gh(['auth', 'status', '--hostname', 'github.com'], { code: 'GITHUB_LOGIN_REQUIRED' });
  } catch {
    return false;
  }
  return true;
}

function readSnapshot() {
  const user = ghJson(['/user']);
  const repository = ghJson([`/repos/${REPOSITORY}`]);
  let branchProtection;
  let branchProtectionReadable = true;
  try { branchProtection = ghJson([`/repos/${REPOSITORY}/branches/main/protection`]); }
  catch { branchProtectionReadable = false; }

  const environments = {};
  for (const name of core.ENVIRONMENTS) {
    try {
      const env = ghJson([`/repos/${REPOSITORY}/environments/${name}`]);
      const policies = ghJson([`/repos/${REPOSITORY}/environments/${name}/deployment-branch-policies`]);
      const reviewers = (env.protection_rules ?? [])
        .filter(rule => rule.type === 'required_reviewers')
        .flatMap(rule => rule.reviewers ?? []);
      environments[name] = {
        readable: true,
        reviewers,
        deploymentBranches: (policies.branch_policies ?? []).filter(p => p.type === 'branch').map(p => p.name),
      };
    } catch { environments[name] = { readable: false }; }
  }

  let variablesResponse;
  try { variablesResponse = ghJson([`/repos/${REPOSITORY}/actions/variables`]); }
  catch { throw new SetupBlocked('ACTIONS_VARIABLES_READ_FAILED', LINKS.variables); }
  const variableValues = new Map((variablesResponse.variables ?? []).map(item => [item.name, item.value]));
  const secrets = {};
  for (const env of ['catalog-test', 'catalog-stable']) {
    let response;
    try { response = ghJson([`/repos/${REPOSITORY}/environments/${env}/secrets`]); }
    catch { throw new SetupBlocked(`ENVIRONMENT_SECRETS_READ_FAILED_${env.toUpperCase().replaceAll('-', '_')}`, LINKS.secrets); }
    secrets[env] = (response.secrets ?? []).some(item => item.name === core.SECRET_NAME);
  }
  let publicRoot = null;
  try {
    const response = ghJson([`/repos/${REPOSITORY}/contents/trust/root.json?ref=main`]);
    publicRoot = Buffer.from(response.content, 'base64').toString('utf8');
  } catch (error) {
    if (!(error instanceof SetupBlocked)) throw error;
    // A 404 is the expected first-run state. The CLI intentionally keeps the
    // error body private; a failed authenticated read is handled as blocked below.
    if (error.httpStatus === 404) publicRoot = null;
    else throw new SetupBlocked('PUBLIC_ROOT_READ_FAILED', LINKS.branches);
  }
  return {
    authenticatedUser: user.login,
    repositoryAdmin: repository.permissions?.admin === true,
    branchProtectionReadable,
    branchProtection,
    environments,
    existingTestSecret: secrets['catalog-test'],
    existingStableSecret: secrets['catalog-stable'],
    testProvisioned: variableValues.get('TEMPLATE_TEST_PUBLICATION_PROVISIONED') === 'true',
    stableProvisioned: variableValues.get('TEMPLATE_PUBLICATION_PROVISIONED') === 'true',
    publicRoot,
  };
}

function checkGhInstalled() {
  try {
    const version = run('gh', ['--version'], { code: 'GH_REQUIRED' }).match(/gh version (\d+)\.(\d+)/i);
    if (!version || Number(version[1]) < 2 || Number(version[2]) < 40) throw new SetupBlocked('GH_VERSION_TOO_OLD');
  } catch (error) {
    if (error instanceof SetupBlocked && error.code === 'GH_VERSION_TOO_OLD') throw error;
    throw new SetupBlocked('GH_REQUIRED');
  }
}

function checkGitInstalled() {
  try {
    const version = run('git', ['--version'], { code: 'GIT_REQUIRED' }).match(/git version (\d+)\.(\d+)/i);
    if (!version || Number(version[1]) < 2) throw new SetupBlocked('GIT_VERSION_TOO_OLD');
  } catch (error) {
    if (error instanceof SetupBlocked && error.code === 'GIT_VERSION_TOO_OLD') throw error;
    throw new SetupBlocked('GIT_REQUIRED');
  }
}

function privateDirectoryAcl(directory) {
  const account = run('whoami', [], { code: 'WINDOWS_ACCOUNT_UNKNOWN' });
  run('icacls', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F', '/T', '/C'], { code: 'PRIVATE_ACL_FAILED' });
}

function verifyRemovableBackupMedia(keyDirectory, backupDirectory, spawn = spawnSync) {
  const keyDrive = path.win32.parse(path.win32.resolve(keyDirectory)).root.slice(0, 1);
  const backupDrive = path.win32.parse(path.win32.resolve(backupDirectory)).root.slice(0, 1);
  const script = [
    "$ErrorActionPreference='Stop'",
    `$keyPartition=Get-Partition -DriveLetter '${keyDrive}'`,
    `$backupPartition=Get-Partition -DriveLetter '${backupDrive}'`,
    '$keyDisk=Get-Disk -Number $keyPartition.DiskNumber',
    '$backupDisk=Get-Disk -Number $backupPartition.DiskNumber',
    "if ($keyDisk.Number -ne $backupDisk.Number -and -not $backupDisk.IsBoot -and @('USB','SD','MMC') -contains [string]$backupDisk.BusType) { 'XRS_BACKUP_MEDIA_OK' } else { exit 3 }",
  ].join('; ');
  const result = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 });
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'XRS_BACKUP_MEDIA_OK') throw new SetupBlocked('BACKUP_MUST_BE_SEPARATE_REMOVABLE_MEDIA');
  return true;
}

async function writeExclusive(file, data, mode = 0o600) {
  const handle = await fs.open(file, 'wx', mode);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

async function removeLocalSigningKey(directory, role) {
  const file = path.join(directory, `${role}-signing.pem`);
  try { await fs.unlink(file); }
  catch (error) { if (error.code !== 'ENOENT') throw new SetupBlocked(`LOCAL_${role.toUpperCase()}_KEY_CLEANUP_FAILED`); }
}

async function saveState(file, state) {
  const text = core.safeState(state);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeExclusive(temp, text, 0o600);
  await fs.rename(temp, file);
}

async function recoverUnrecordedKeySetup(paths, prompts, base, stateFile) {
  const backupFile = path.join(paths.backupDirectory, 'root-v1.xrskey');
  const files = {
    root: path.join(paths.keyDirectory, 'root.json'),
    test: path.join(paths.keyDirectory, 'test-signing.pem'),
    stable: path.join(paths.keyDirectory, 'stable-signing.pem'),
    backup: backupFile,
  };
  const artifacts = await Promise.all(Object.values(files).map(file => fs.stat(file).then(() => true).catch(() => false)));
  if (artifacts.some(Boolean) && !artifacts.every(Boolean)) throw new SetupBlocked('PARTIAL_KEY_SETUP_REQUIRES_OWNER_REVIEW');
  if (!artifacts.every(Boolean)) return null;

  let root, testPem, stablePem;
  try {
    root = protocol.parse(await fs.readFile(files.root));
    protocol.validateRoot(root);
    testPem = await fs.readFile(files.test, 'utf8');
    stablePem = await fs.readFile(files.stable, 'utf8');
  } catch { throw new SetupBlocked('KEY_SETUP_RECOVERY_INVALID'); }
  const ids = {
    root: root.roles.root.keyIds[0],
    test: protocol.keyId(require('node:crypto').createPublicKey(testPem).export({ type: 'spki', format: 'pem' })),
    stable: protocol.keyId(require('node:crypto').createPublicKey(stablePem).export({ type: 'spki', format: 'pem' })),
  };
  if (ids.test !== root.roles.test.keyIds[0] || ids.stable !== root.roles.stable.keyIds[0]) throw new SetupBlocked('KEY_SETUP_RECOVERY_MISMATCH');
  const passphrase = await prompts.hidden('Проверка ранее созданной зашифрованной root-копии. Введите её пароль: ');
  let rootPem;
  try { rootPem = core.decryptRootBackup(await fs.readFile(files.backup), passphrase); }
  catch { throw new SetupBlocked('ROOT_BACKUP_RECOVERY_FAILED'); }
  if (protocol.keyId(require('node:crypto').createPublicKey(rootPem).export({ type: 'spki', format: 'pem' })) !== ids.root) throw new SetupBlocked('ROOT_BACKUP_RECOVERY_MISMATCH');
  const backupBytes = await fs.readFile(files.backup);
  privateDirectoryAcl(paths.keyDirectory);
  privateDirectoryAcl(base);
  const state = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    keyDirectory: paths.keyDirectory,
    rootBackupDirectory: paths.backupDirectory,
    rootBackupSha256: require('node:crypto').createHash('sha256').update(backupBytes).digest('hex'),
    keyIds: ids,
    root,
    testSecretUploaded: false,
    stableSecretUploaded: false,
    pendingSecretUpload: null,
    rootPullRequest: null,
    rootPublished: false,
  };
  await saveState(stateFile, state);
  return { root, testPem, stablePem, state };
}

function hidden(prompt, input = process.stdin, output = process.stdout) {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') return reject(new SetupBlocked('INTERACTIVE_TTY_REQUIRED'));
    output.write(prompt);
    let value = '';
    const onData = chunk => {
      const text = chunk.toString('utf8');
      for (const char of text) {
        if (char === '\u0003') { input.setRawMode(false); input.off('data', onData); output.write('\n'); reject(new SetupBlocked('CANCELLED')); return; }
        if (char === '\r' || char === '\n') { input.setRawMode(false); input.off('data', onData); output.write('\n'); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else if (char >= ' ') value += char;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

function createPrompts(input = process.stdin, output = process.stdout) {
  let rl = readline.createInterface({ input, output });
  return {
    ask: prompt => rl.question(prompt),
    close: () => rl.close(),
    hidden: async prompt => {
      // readline echoes terminal input, so it must not be attached while a
      // private backup passphrase is entered in raw, non-echoing mode.
      rl.close();
      try { return await hidden(prompt, input, output); }
      finally { rl = readline.createInterface({ input, output }); }
    },
  };
}

function showBlocker(error, output = process.stdout) {
  output.write(`\nНастройка остановлена: ${error.code ?? 'UNKNOWN_ERROR'}.\n`);
  if (error.link) output.write(`Проверьте настройки: ${error.link}\n`);
  if (['GH_REQUIRED', 'GH_VERSION_TOO_OLD'].includes(error.code)) output.write('Установите официальную GitHub CLI: https://cli.github.com/\n');
  if (['GIT_REQUIRED', 'GIT_VERSION_TOO_OLD'].includes(error.code)) output.write('Установите Git for Windows: https://git-scm.com/download/win\n');
  if (error.code === 'NODE_24_REQUIRED') output.write('Установите Node.js 24 LTS: https://nodejs.org/\n');
  if (error.code === 'WINDOWS_11_REQUIRED') output.write('Этот мастер запускается только в Windows 11.\n');
  if (error.code === 'BACKUP_MUST_BE_SEPARATE_REMOVABLE_MEDIA') output.write('Root backup разрешён только на отдельном USB/SD/MMC-носителе, физически отличном от системного диска. Подключите носитель и повторите запуск.\n');
}

async function createTrustRootPullRequest(root, state, stateFile, output = process.stdout) {
  const current = readSnapshot().publicRoot;
  if (current && current !== 'unreadable-or-missing') {
    let existing;
    try { existing = protocol.parse(Buffer.from(current, 'utf8')); protocol.validateRoot(existing); }
    catch { throw new SetupBlocked('PUBLIC_ROOT_INVALID'); }
    if (protocol.canonical(existing) !== protocol.canonical(root)) throw new SetupBlocked('PUBLIC_ROOT_MISMATCH');
    state.rootPublished = true;
    await saveState(stateFile, state);
    output.write('Открытый корень в main совпадает с локально созданным.\n');
    return;
  }
  if (current === 'unreadable-or-missing') throw new SetupBlocked('PUBLIC_ROOT_READ_FAILED', LINKS.branches);

  const suffix = Object.keys(root.keys)[0].slice(0, 8);
  const branch = `codex/xrs-trust-root-v${root.version}-${suffix}`;
  let pr;
  try {
    pr = JSON.parse(gh(['pr', 'list', '--repo', REPOSITORY, '--head', `${OWNER}:${branch}`, '--state', 'open', '--json', 'url,headRefName']));
  } catch { throw new SetupBlocked('PULL_REQUEST_LOOKUP_FAILED'); }
  if (pr.length) {
    state.rootPullRequest = pr[0].url;
    await saveState(stateFile, state);
    output.write(`Ожидается review публичного корня: ${pr[0].url}\n`);
    return;
  }

  const worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'xrs-root-pr-'));
  let added = false;
  try {
    run('git', ['fetch', 'origin', 'main'], { cwd: ROOT, code: 'GIT_FETCH_FAILED' });
    const remoteRef = spawnSync('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (remoteRef.error) throw new SetupBlocked('GIT_REMOTE_LOOKUP_FAILED');
    const hasRemoteBranch = remoteRef.status === 0 && remoteRef.stdout.trim().length > 0;
    const localRef = spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: ROOT, windowsHide: true });
    if (localRef.error) throw new SetupBlocked('GIT_LOCAL_LOOKUP_FAILED');
    const hasLocalBranch = localRef.status === 0;
    if (hasRemoteBranch) {
      run('git', ['fetch', 'origin', branch], { cwd: ROOT, code: 'GIT_BRANCH_FETCH_FAILED' });
      run('git', ['worktree', 'add', '--detach', worktree, `origin/${branch}`], { cwd: ROOT, code: 'GIT_WORKTREE_FAILED' });
    } else if (hasLocalBranch) {
      run('git', ['worktree', 'add', '--detach', worktree, branch], { cwd: ROOT, code: 'GIT_WORKTREE_FAILED' });
    } else {
      run('git', ['worktree', 'add', '-b', branch, worktree, 'origin/main'], { cwd: ROOT, code: 'GIT_WORKTREE_FAILED' });
    }
    added = true;
    const rootFile = path.join(worktree, 'trust', 'root.json');
    if (hasRemoteBranch || hasLocalBranch) {
      let stagedRoot;
      try { stagedRoot = protocol.parse(await fs.readFile(rootFile)); protocol.validateRoot(stagedRoot); }
      catch { throw new SetupBlocked('ROOT_PR_BRANCH_CONFLICT'); }
      if (protocol.canonical(stagedRoot) !== protocol.canonical(root)) throw new SetupBlocked('ROOT_PR_BRANCH_CONFLICT');
      if (!hasRemoteBranch) run('git', ['push', '-u', 'origin', branch], { cwd: worktree, code: 'GIT_BRANCH_PUSH_FAILED' });
    } else {
      await fs.mkdir(path.dirname(rootFile), { recursive: true });
      await writeExclusive(rootFile, protocol.bytes(root), 0o644);
      run('git', ['add', 'trust/root.json'], { cwd: worktree, code: 'GIT_ADD_FAILED' });
      run('git', ['-c', 'user.name=XRS Templates Setup', '-c', 'user.email=xrs-templates-setup@users.noreply.github.com', 'commit', '-m', `Add XRS template trust root v${root.version}`], { cwd: worktree, code: 'GIT_COMMIT_FAILED' });
      run('git', ['push', '-u', 'origin', branch], { cwd: worktree, code: 'GIT_BRANCH_PUSH_FAILED' });
    }
    const body = 'Adds only the public Ed25519 trust root generated by the owner-run XRS Templates Setup Wizard. No private keys or template revisions are included. Validate must pass and an authorized owner must review and merge this PR.';
    const url = gh(['pr', 'create', '--repo', REPOSITORY, '--base', 'main', '--head', branch, '--title', `Add XRS template trust root v${root.version}`, '--body', body]);
    state.rootPullRequest = url;
    state.rootBranch = branch;
    await saveState(stateFile, state);
    output.write(`Создан PR с публичным root.json: ${url}\n`);
  } finally {
    if (added) {
      try { run('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, code: 'GIT_WORKTREE_CLEANUP_FAILED' }); } catch {}
    } else await fs.rm(worktree, { recursive: true, force: true });
  }
}

async function runWizard({ platform = process.platform, env = process.env, input = process.stdin, output = process.stdout, spawn = spawnSync } = {}) {
  if (platform !== 'win32' || Number((os.release().split('.')[2] ?? 0)) < 22000) throw new SetupBlocked('WINDOWS_11_REQUIRED');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new SetupBlocked('NODE_24_REQUIRED');
  checkGhInstalled();
  checkGitInstalled();
  if (!authCheck()) {
    output.write('Войдите через официальный GitHub CLI. Пароль вводится только на GitHub; мастер его не запрашивает.\n');
    const login = spawnSync('gh', ['auth', 'login', '--hostname', 'github.com', '--web'], { stdio: 'inherit', windowsHide: false });
    if (login.error || login.status !== 0) throw new SetupBlocked('GITHUB_LOGIN_FAILED');
  }
  let snapshot;
  try { snapshot = readSnapshot(); }
  catch (error) {
    if (error instanceof SetupBlocked) throw new SetupBlocked('GITHUB_API_PERMISSION_OR_NETWORK', LINKS.branches);
    throw error;
  }
  output.write(`GitHub-аккаунт: ${snapshot.authenticatedUser}; доступ администратора к ${REPOSITORY}: ${snapshot.repositoryAdmin ? 'есть' : 'нет'}.\n`);
  const prompts = createPrompts(input, output);
  try {
    const base = path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'XRS-Templates-Setup');
    const stateFile = path.join(base, 'setup-state.json');
    let state;
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new SetupBlocked('STATE_FILE_INVALID'); }
    snapshot.wizardState = state;
    const blockers = core.validateSnapshot(snapshot);
    if (blockers.length) {
      output.write('Проверка GitHub не пройдена:\n'+blockers.map(code => `- ${code}`).join('\n')+'\n');
      if (blockers.some(code => code.includes('protection'))) output.write(`Проверьте защиту main: ${LINKS.branches}\n`);
      if (blockers.some(code => code.includes('environment'))) output.write(`Проверьте Environments: ${LINKS.environments}\n`);
      if (blockers.some(code => code.includes('secret'))) output.write(`Проверьте Secrets: ${LINKS.secrets}\n`);
      throw new SetupBlocked('GITHUB_CONFIGURATION_INCOMPLETE');
    }
    if (snapshot.stableProvisioned) throw new SetupBlocked('STABLE_ALREADY_ACTIVATED', LINKS.variables);
    const keyDefault = state?.keyDirectory || path.join(base, 'private');
    const backupDefault = state?.rootBackupDirectory || '';
    const keyDirectory = await prompts.ask(`Защищённая папка для ключей test/Stable [${keyDefault}]: `) || keyDefault;
    const backupDirectory = await prompts.ask(`Новая папка на отдельном носителе для зашифрованного root backup${backupDefault ? ` [${backupDefault}]` : ''}: `) || backupDefault;
    if (!backupDirectory) throw new SetupBlocked('ROOT_BACKUP_DIRECTORY_REQUIRED');
    const paths = core.validateKeyDirectory({ repositoryRoot: ROOT, keyDirectory, backupDirectory, platform });
    verifyRemovableBackupMedia(paths.keyDirectory, paths.backupDirectory, spawn);

    if (state && state.keyDirectory !== paths.keyDirectory) throw new SetupBlocked('SETUP_STATE_PATH_MISMATCH');
    if (state && (!state.root || !state.keyIds)) throw new SetupBlocked('SETUP_STATE_INCOMPLETE');
    if (!state && snapshot.publicRoot !== null) throw new SetupBlocked('PUBLIC_ROOT_ALREADY_CONFIGURED', LINKS.branches);

    let root;
    let testPem;
    let stablePem;
    if (state?.root && state?.keyIds && state?.keyDirectory === paths.keyDirectory) {
      root = state.root;
      protocol.validateRoot(root);
      const backup = await fs.readFile(path.join(paths.backupDirectory, 'root-v1.xrskey')).catch(() => null);
      if (!backup || require('node:crypto').createHash('sha256').update(backup).digest('hex') !== state.rootBackupSha256) {
        throw new SetupBlocked('ROOT_BACKUP_MISSING_OR_CHANGED');
      }
      for (const [role, field] of [['test', 'testSecretUploaded'], ['stable', 'stableSecretUploaded']]) {
        const keyFile = path.join(paths.keyDirectory, `${role}-signing.pem`);
        let pem = await fs.readFile(keyFile, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
        if (!pem && !state[field]) throw new SetupBlocked(`LOCAL_${role.toUpperCase()}_KEY_MISSING`);
        if (pem) {
          const pub = require('node:crypto').createPublicKey(pem).export({ type: 'spki', format: 'pem' });
          if (protocol.keyId(pub) !== state.keyIds[role]) throw new SetupBlocked(`LOCAL_${role.toUpperCase()}_KEY_MISMATCH`);
        }
        if (role === 'test') testPem = pem;
        else stablePem = pem;
      }
      output.write('Найдена предыдущая защищённая сессия; существующие ключи будут использованы повторно.\n');
    } else {
      const keyDirApi = platform === 'win32' ? path.win32 : path;
      const parent = keyDirApi.dirname(paths.keyDirectory);
      const keyDirExists = !!(await fs.stat(paths.keyDirectory).catch(() => null));
      const backupDirExists = !!(await fs.stat(paths.backupDirectory).catch(() => null));
      if (keyDirExists || backupDirExists) {
        const recovered = await recoverUnrecordedKeySetup(paths, prompts, base, stateFile);
        if (!recovered) throw new SetupBlocked('PARTIAL_KEY_SETUP_REQUIRES_OWNER_REVIEW');
        ({ root, testPem, stablePem, state } = recovered);
        output.write('Восстановлено состояние незавершённого мастера; существующие ключи сохранены.\n');
      } else {
        const consent = await prompts.ask('Создать три Ed25519 пары? Для явного подтверждения введите CREATE THREE KEYS: ');
        if (consent !== 'CREATE THREE KEYS') throw new SetupBlocked('KEY_CREATION_NOT_CONFIRMED');
        const pass1 = await prompts.hidden('Пароль шифрования root backup (не менее 14 символов, не записывается): ');
        const pass2 = await prompts.hidden('Повторите пароль backup: ');
        if (pass1 !== pass2) throw new SetupBlocked('BACKUP_PASSPHRASE_MISMATCH');
        await fs.mkdir(parent, { recursive: true });
        await fs.mkdir(paths.keyDirectory, { recursive: false });
        const account = run('whoami', [], { code: 'WINDOWS_ACCOUNT_UNKNOWN' });
        // ACLs are applied before any private material touches disk.
        run('icacls', [paths.keyDirectory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { code: 'PRIVATE_ACL_FAILED' });
        const material = core.makeKeySet();
        root = material.root;
        testPem = material.generated.test.privatePem;
        stablePem = material.generated.stable.privatePem;
        await writeExclusive(path.join(paths.keyDirectory, 'root.json'), protocol.bytes(root), 0o644);
        await writeExclusive(path.join(paths.keyDirectory, 'test-signing.pem'), testPem);
        await writeExclusive(path.join(paths.keyDirectory, 'stable-signing.pem'), stablePem);

        await fs.mkdir(paths.backupDirectory, { recursive: false });
        const encrypted = core.encryptRootBackup(material.generated.root.privatePem, pass1);
        run('icacls', [paths.backupDirectory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '/grant:r', '*S-1-5-18:(OI)(CI)F'], { code: 'BACKUP_ACL_FAILED' });
        const backupFile = path.join(paths.backupDirectory, 'root-v1.xrskey');
        await writeExclusive(backupFile, encrypted);
        const readback = await fs.readFile(backupFile);
        const restoredPem = core.decryptRootBackup(readback, pass1);
        const restoredId = protocol.keyId(require('node:crypto').createPublicKey(restoredPem).export({ type: 'spki', format: 'pem' }));
        if (restoredId !== material.generated.root.id) throw new SetupBlocked('ROOT_BACKUP_VERIFY_FAILED');
        material.generated.root.privatePem = '';
        state = {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          keyDirectory: paths.keyDirectory,
          rootBackupDirectory: paths.backupDirectory,
          rootBackupSha256: require('node:crypto').createHash('sha256').update(readback).digest('hex'),
          keyIds: { root: root.roles.root.keyIds[0], test: root.roles.test.keyIds[0], stable: root.roles.stable.keyIds[0] },
          root,
          testSecretUploaded: false,
          stableSecretUploaded: false,
          pendingSecretUpload: null,
          rootPullRequest: null,
          rootPublished: false,
        };
        await fs.mkdir(base, { recursive: true });
        privateDirectoryAcl(base);
        await saveState(stateFile, state);
        output.write(`Созданы отдельные ключи. Зашифрованный root backup проверен: ${backupFile}\n`);
      }
    }

    for (const [environment, role, field] of [
      ['catalog-test', 'test', 'testSecretUploaded'],
      ['catalog-stable', 'stable', 'stableSecretUploaded'],
    ]) {
      const exists = await core.secretListHas(spawn, environment);
      if (state[field] && exists) {
        await removeLocalSigningKey(paths.keyDirectory, role);
        if (role === 'test') testPem = '';
        else stablePem = '';
        continue;
      }
      if (state[field] && !exists) throw new SetupBlocked(`UPLOADED_${environment.toUpperCase().replaceAll('-', '_')}_SECRET_MISSING`, LINKS.secrets);
      const pem = role === 'test' ? testPem : stablePem;
      const expectedId = state.keyIds[role];
      const pendingMatches = state.pendingSecretUpload?.environment === environment && state.pendingSecretUpload?.keyId === expectedId;
      if (exists && !pendingMatches) throw new SetupBlocked(`SECRET_ALREADY_EXISTS_${environment.toUpperCase().replaceAll('-', '_')}`, LINKS.secrets);
      if (pendingMatches) {
        const resume = await prompts.ask(`В GitHub уже виден секрет, передача которого была прервана. Повторно передать тот же ключ ${expectedId.slice(0, 12)} в ${environment}? Напишите RESUME SECRET: `);
        if (resume !== 'RESUME SECRET') throw new SetupBlocked(`SECRET_RESUME_CONFIRMATION_REQUIRED_${environment.toUpperCase().replaceAll('-', '_')}`, LINKS.secrets);
      } else {
        const ok = await prompts.ask(`Передать ${role} private key в Environment ${environment} через GitHub CLI (stdin, без файла передачи)? Напишите YES: `);
        if (ok !== 'YES') throw new SetupBlocked(`OWNER_CONFIRMATION_REQUIRED_${environment.toUpperCase().replaceAll('-', '_')}`);
        state.pendingSecretUpload = { environment, keyId: expectedId };
        await saveState(stateFile, state);
      }
      try { core.setEnvironmentSecret(spawn, environment, pem); }
      catch (error) {
        output.write(`Автоматическая передача секрета не прошла. Проверьте доступ к Actions Secrets: ${LINKS.secrets}\n`);
        output.write('Если GitHub запрещает API-запись, владелец может выполнить локально безопасную передачу без вывода ключа:\n');
        const secretPath = path.join(paths.keyDirectory, role === 'test' ? 'test-signing.pem' : 'stable-signing.pem').replaceAll("'", "''");
        output.write(`Get-Content -Raw -LiteralPath '${secretPath}' | gh secret set ${core.SECRET_NAME} --env ${environment} --repo ${REPOSITORY}\n`);
        throw new SetupBlocked(error.message, LINKS.secrets);
      }
      if (!(await core.secretListHas(spawn, environment))) throw new SetupBlocked(`SECRET_NOT_VISIBLE_${environment.toUpperCase().replaceAll('-', '_')}`, LINKS.secrets);
      state[field] = true;
      state.pendingSecretUpload = null;
      await saveState(stateFile, state);
      await removeLocalSigningKey(paths.keyDirectory, role);
      if (role === 'test') testPem = '';
      else stablePem = '';
      output.write(`Секрет ${core.SECRET_NAME} передан в ${environment}; значение не читается и не отображалось.\n`);
    }

    await createTrustRootPullRequest(root, state, stateFile, output);
    if (state.rootPublished && !snapshot.testProvisioned) {
      const enableTest = await prompts.ask('Открытый root принят в main. Разрешить только изолированные test-публикации? Для подтверждения введите ENABLE TEST: ');
      if (enableTest === 'ENABLE TEST') {
        run('gh', ['variable', 'set', 'TEMPLATE_TEST_PUBLICATION_PROVISIONED', '--body', 'true', '--repo', REPOSITORY], { code: 'TEST_FLAG_WRITE_FAILED' });
        state.testProvisioned = true;
        await saveState(stateFile, state);
        output.write('Разрешён только test-канал. Stable-публикация по-прежнему закрыта.\n');
      } else output.write(`Для test-канала владелец может вручную включить только TEMPLATE_TEST_PUBLICATION_PROVISIONED: ${LINKS.variables}\n`);
    }
    output.write('\nStable-публикация остаётся отключённой. Мастер не устанавливает TEMPLATE_PUBLICATION_PROVISIONED=true.\n');
    if (!state.rootPublished) output.write('Остановитесь после validate и дождитесь review/merge PR; затем повторно запустите мастер.\n');
    else output.write(`После проверки тестового канала владелец отдельно активирует Stable: ${LINKS.variables}\n`);
    return state;
  } finally { prompts.close(); }
}

if (require.main === module) {
  process.stdout.write('XRS-Templates Setup Wizard — защищённая первоначальная настройка GitHub.\n');
  process.stdout.write('Ключи создаются только после вашей явной команды и никогда не выводятся.\n');
  runWizard().catch(error => { showBlocker(error); process.exitCode = 1; });
}

module.exports = { ROOT, LINKS, SetupBlocked, run, gh, readSnapshot, authCheck, privateDirectoryAcl, verifyRemovableBackupMedia, saveState, createTrustRootPullRequest, runWizard, showBlocker };
