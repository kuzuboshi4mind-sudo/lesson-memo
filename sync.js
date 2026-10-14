// Firebase（メール＋パスワードでログイン、Firestore に保存）で端末間の同期をする。
// データは users/{uid}/months/{YYYY-MM} に { items, updatedAt } として月ごとに保存する。
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const MERGED_KEY = 'lessonMemo.mergedUid';   // この端末のメモをアカウントに取り込み済みか
const PENDING_KEY = 'lessonMemo.pending';    // まだ送れていない月（アプリを閉じても覚えておく）
const WRITE_DELAY = 800;

const app = window.memoApp;
const $ = (id) => document.getElementById(id);
const cloudBtn = $('cloud');

if (firebaseConfig && app) start();

async function start() {
  cloudBtn.hidden = false;
  setState('busy', '接続中…');

  const [{ initializeApp }, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const fbApp = initializeApp(firebaseConfig);
  const authInst = auth.getAuth(fbApp);
  let db;
  try {
    db = fs.initializeFirestore(fbApp, { localCache: fs.persistentLocalCache() });
  } catch (e) {
    db = fs.getFirestore(fbApp);
  }

  let user = null;
  let unsub = null;
  let merged = false;
  const dirty = new Set(loadPending());
  const timers = {};

  // ---- 送信 ----
  function loadPending() {
    try { return JSON.parse(localStorage.getItem(PENDING_KEY)) || []; } catch (e) { return []; }
  }
  function savePending() {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify([...dirty])); } catch (e) {}
  }
  const monthDoc = (k) => fs.doc(db, 'users', user.uid, 'months', k);

  function write(k) {
    clearTimeout(timers[k]);
    delete timers[k];
    if (!user || !merged) return;
    const items = app.months()[k] || [];
    dirty.delete(k);
    savePending();
    // オフラインでも端末内に溜まり、つながったときに送られる
    fs.setDoc(monthDoc(k), { items, updatedAt: fs.serverTimestamp() }).catch((e) => {
      console.error(e);
      dirty.add(k);
      savePending();
      setState('off', '保存に失敗しました');
    });
  }
  function flushAll() {
    for (const k of [...dirty]) write(k);
  }

  app.onChange = (k) => {
    dirty.add(k);
    savePending();
    if (!user || !merged) return;
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => write(k), WRITE_DELAY);
  };
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });

  // ---- 受信 ----
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // 初めてログインした端末では、この端末のメモとアカウントのメモを合わせる（どちらも消さない）
  function mergeItems(remote, local) {
    const out = remote.map((it) => ({ ...it }));
    const ids = new Set(out.map((it) => it.id));
    let prevId = null;
    for (const it of local) {
      if (!ids.has(it.id)) {
        const at = prevId ? out.findIndex((x) => x.id === prevId) + 1 : 0;
        out.splice(at, 0, { ...it });
        ids.add(it.id);
      }
      prevId = it.id;
    }
    return out;
  }

  function onSnap(snap) {
    const remote = {};
    snap.forEach((d) => { remote[d.id] = d; });

    if (!merged) {
      // サーバーの最新を受け取るまで待ってから合わせる
      if (snap.metadata.fromCache) return;
      const local = app.months();
      const doMerge = localStorage.getItem(MERGED_KEY) !== user.uid;
      for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
        const r = remote[k] ? remote[k].data().items || [] : [];
        if (dirty.has(k)) continue; // 送れていない変更は手元を正とする
        if (doMerge && local[k]?.length) {
          const m = mergeItems(r, local[k]);
          if (!same(m, r)) dirty.add(k);
          if (!same(m, local[k])) app.setMonth(k, m);
        } else if (!remote[k]) {
          if (local[k]?.length) dirty.add(k); // アカウントにまだ無い月は送る
        } else if (!same(r, local[k] || [])) {
          app.setMonth(k, r);
        }
      }
      try { localStorage.setItem(MERGED_KEY, user.uid); } catch (e) {}
      merged = true;
      flushAll();
    } else {
      const local = app.months();
      for (const [k, d] of Object.entries(remote)) {
        if (d.metadata.hasPendingWrites || dirty.has(k) || timers[k]) continue;
        const r = d.data().items || [];
        if (!same(r, local[k] || [])) app.setMonth(k, r);
      }
    }

    if (snap.metadata.hasPendingWrites || dirty.size) setState('busy', '送信待ち（オフライン）');
    else if (snap.metadata.fromCache) setState('busy', 'オフライン');
    else setState('ok', '同期済み');
  }

  auth.onAuthStateChanged(authInst, (u) => {
    if (unsub) { unsub(); unsub = null; }
    user = u;
    merged = false;
    renderSheet();
    if (!u) { setState('off', '未ログイン'); return; }
    setState('busy', '同期中…');
    unsub = fs.onSnapshot(
      fs.collection(db, 'users', u.uid, 'months'),
      { includeMetadataChanges: true },
      onSnap,
      (e) => { console.error(e); setState('off', '同期できません（' + e.code + '）'); },
    );
  });

  // ---- 画面 ----
  let stateText = '';
  function setState(cls, text) {
    cloudBtn.className = 'cloud ' + cls;
    stateText = text;
    $('syncState').textContent = text;
  }
  function renderSheet() {
    $('signedOut').hidden = !!user;
    $('signedIn').hidden = !user;
    $('who').textContent = user ? user.email : '';
    $('syncState').textContent = stateText;
    $('authErr').textContent = '';
  }
  const openSheet = () => { renderSheet(); $('sheet').hidden = false; };
  const closeSheet = () => { $('sheet').hidden = true; };
  cloudBtn.onclick = openSheet;
  $('closeSheet').onclick = closeSheet;
  $('sheet').onclick = (e) => { if (e.target === $('sheet')) closeSheet(); };

  const MESSAGES = {
    'auth/invalid-email': 'メールアドレスの形が正しくありません',
    'auth/missing-password': 'パスワードを入力してください',
    'auth/weak-password': 'パスワードは6文字以上にしてください',
    'auth/email-already-in-use': 'このメールアドレスは登録済みです。「ログイン」を押してください',
    'auth/invalid-credential': 'メールアドレスかパスワードが違います',
    'auth/wrong-password': 'メールアドレスかパスワードが違います',
    'auth/user-not-found': 'メールアドレスかパスワードが違います',
    'auth/too-many-requests': '試行回数が多すぎます。しばらく待ってからお試しください',
    'auth/network-request-failed': 'ネットにつながっていません',
  };
  async function run(btn, fn) {
    $('authErr').textContent = '';
    btn.disabled = true;
    try {
      await fn($('email').value.trim(), $('password').value);
    } catch (e) {
      $('authErr').textContent = MESSAGES[e.code] || 'エラー：' + (e.code || e.message);
    } finally {
      btn.disabled = false;
    }
  }
  $('signIn').onclick = () => run($('signIn'), async (email, pw) => {
    await auth.signInWithEmailAndPassword(authInst, email, pw);
    closeSheet();
  });
  $('signUp').onclick = () => run($('signUp'), async (email, pw) => {
    await auth.createUserWithEmailAndPassword(authInst, email, pw);
    closeSheet();
  });
  $('reset').onclick = () => run($('reset'), async (email) => {
    if (!email) throw { message: 'メールアドレスを入力してから押してください' };
    await auth.sendPasswordResetEmail(authInst, email);
    $('authErr').textContent = '再設定用のメールを送りました';
  });
  $('signOut').onclick = async () => {
    flushAll();
    await auth.signOut(authInst);
  };
}
