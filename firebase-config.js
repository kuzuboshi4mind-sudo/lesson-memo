// Firebase コンソールの「プロジェクトの設定 → マイアプリ → SDK の設定と構成」の値。
// ウェブアプリでは公開される前提の値で、データはセキュリティルール（firestore.rules）で守る。
// null にすると同期は使わず、この端末の中だけに保存する。
export const firebaseConfig = {
  apiKey: 'AIzaSyAsaMZrZu8RuQ6Bqv1-PgsVCHA1joKIJqo',
  authDomain: 'lesson-memo-69efb.firebaseapp.com',
  projectId: 'lesson-memo-69efb',
  storageBucket: 'lesson-memo-69efb.firebasestorage.app',
  messagingSenderId: '1027361639718',
  appId: '1:1027361639718:web:db4fcb88a22822d01005e7',
};
