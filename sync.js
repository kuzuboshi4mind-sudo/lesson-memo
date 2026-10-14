// Firebase（メール＋パスワードでログイン、Firestore に保存）で端末間の同期をする。
// メモは1項目ずつ users/{uid}/items/{id} に { m: 'YYYY-MM', text, done, t, pos } として保存する。
// 項目ごとに保存するので、2台で同時に書いたりオフラインで書いたりしても、互いのメモを上書きしない。
import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2';
const PENDING_KEY = 'lessonMemo.pending';  // まだ送れていない月（アプリを閉じても覚えておく）
const SEEN_KEY = 'lessonMemo.seen.';       // + uid：この端末が一度でも同期した項目の id
const WRITE_DELAY = 800;

const app = window.memoApp;
const $ = (id) => document.getElementById(id);
const cloudBtn = $('cloud');

let stateText = '';

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
  let ready = false;            // サーバーの最新を一度受け取ったか
  let remote = new Map();       // id -> { m, text, done, t, pos }（Firestore 上の状態）
  const pos = new Map();        // id -> 並び順の値（送信前に決めたものも含む）
  let seen = new Set();         // この端末が知っている項目。消したときだけ削除を送るのに使う
  const dirty = new Set(readJSON(PENDING_KEY, []));
  const timers = {};

  function readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) || fallback; } catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }
  const savePending = () => writeJSON(PENDING_KEY, [...dirty]);
  const saveSeen = () => { if (user) writeJSON(SEEN_KEY + user.uid, [...seen]); };

  // ---- 送信 ----
  // 並び順：既存の項目は今の値のまま、新しい項目は前後の項目の間の値にする
  function assignPos(items) {
    items.forEach((it, i) => {
      if (pos.has(it.id)) return;
      const prev = i > 0 ? pos.get(items[i - 1].id) : undefined;
      let next;
      for (let j = i + 1; j < items.length; j++) {
        if (pos.has(items[j].id)) { next = pos.get(items[j].id); break; }
      }
      let p;
      if (prev !== undefined && next !== undefined) p = (prev + next) / 2;
      else if (prev !== undefined) p = prev + 1;
      else if (next !== undefined) p = next - 1;
      else p = 0;
      pos.set(it.id, p);
    });
  }

  function write(k) {
    clearTimeout(timers[k]);
    delete timers[k];
    if (!user || !ready) return;
    const items = app.months()[k] || [];
    assignPos(items);
    const col = fs.collection(db, 'users', user.uid, 'items');
    const batch = fs.writeBatch(db);
    let ops = 0;
    const ids = new Set();
    for (const it of items) {
      ids.add(it.id);
      const doc = { m: k, text: it.text, done: !!it.done, t: it.t, pos: pos.get(it.id) };
      const r = remote.get(it.id);
      if (!r || r.m !== doc.m || r.text !== doc.text || r.done !== doc.done || r.t !== doc.t || r.pos !== doc.pos) {
        batch.set(fs.doc(col, it.id), doc);
        ops++;
      }
      seen.add(it.id);
    }
    // この端末で消した項目だけ削除する（他の端末で増えたばかりの項目は消さない）
    for (const [id, r] of remote) {
      if (r.m === k && !ids.has(id) && seen.has(id)) {
        batch.delete(fs.doc(col, id));
        seen.delete(id);
        ops++;
      }
    }
    dirty.delete(k);
    savePending();
    saveSeen();
    if (!ops) return 0;
    // オフラインでも端末内に溜まり、つながったときに送られる
    batch.commit().catch((e) => {
      console.error(e);
      dirty.add(k);
      savePending();
      setState('off', '保存に失敗しました');
    });
    return ops;
  }
  function flushAll() {
    let ops = 0;
    for (const k of [...dirty]) ops += write(k) || 0;
    return ops;
  }

  app.onChange = (k) => {
    dirty.add(k);
    savePending();
    if (!user || !ready) return;
    clearTimeout(timers[k]);
    timers[k] = setTimeout(() => write(k), WRITE_DELAY);
  };
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushAll(); });

  // ---- 受信 ----
  const sameList = (a, b) => a.length === b.length && a.every((x, i) =>
    x.id === b[i].id && x.text === b[i].text && !!x.done === !!b[i].done && x.t === b[i].t);

  function onSnap(snap) {
    remote = new Map();
    const byMonth = {};
    snap.forEach((d) => {
      const r = d.data();
      remote.set(d.id, r);
      pos.set(d.id, r.pos);
      (byMonth[r.m] ||= []).push({ id: d.id, text: r.text, done: !!r.done, t: r.t, pos: r.pos });
    });

    if (!ready) {
      // サーバーの最新を受け取るまで待ってから、この端末のメモを送る（アカウントのメモと合わさる）
      if (snap.metadata.fromCache) return;
      ready = true;
      for (const [k, items] of Object.entries(app.months())) if (items.length) dirty.add(k);
      // 送った分を含む次の通知で画面に反映する
      if (flushAll()) return updateState(snap);
    }

    const local = app.months();
    for (const k of new Set([...Object.keys(byMonth), ...Object.keys(local)])) {
      if (dirty.has(k) || timers[k]) continue; // 書きかけの月は送ったあとで反映する
      const list = (byMonth[k] || [])
        .sort((a, b) => a.pos - b.pos || a.t - b.t || (a.id < b.id ? -1 : 1))
        .map(({ id, text, done, t }) => ({ id, text, done, t }));
      if (!sameList(list, local[k] || [])) app.setMonth(k, list);
      list.forEach((it) => seen.add(it.id));
    }
    saveSeen();
    updateState(snap);
  }

  function updateState(snap) {
    if (snap.metadata.fromCache) setState('busy', 'オフライン（つながったら自動で送ります）');
    else if (snap.metadata.hasPendingWrites || dirty.size) setState('busy', '送信中…');
    else setState('ok', '同期済み');
  }

  auth.onAuthStateChanged(authInst, (u) => {
    if (unsub) { unsub(); unsub = null; }
    user = u;
    ready = false;
    remote = new Map();
    pos.clear();
    seen = new Set(u ? readJSON(SEEN_KEY + u.uid, []) : []);
    renderSheet();
    if (!u) { setState('off', '未ログイン'); return; }
    setState('busy', '同期中…');
    unsub = fs.onSnapshot(
      fs.collection(db, 'users', u.uid, 'items'),
      { includeMetadataChanges: true },
      onSnap,
      (e) => { console.error(e); setState('off', '同期できません（' + e.code + '）'); },
    );
  });

  // ---- 画面 ----
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
    // 次にログインしたときは、その間にこの端末で書いたメモもアカウントに合わせる
    try { localStorage.removeItem(SEEN_KEY + user.uid); } catch (e) {}
    await auth.signOut(authInst);
  };
}

function setState(cls, text) {
  cloudBtn.className = 'cloud ' + cls;
  stateText = text;
  $('syncState').textContent = text;
}
