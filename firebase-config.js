// ============================================================
// firebase-config.js
// Initialize Firebase and export Firestore instance.
// Replace the firebaseConfig values with your own project's
// credentials from the Firebase Console.
// ============================================================


// 🔧 REPLACE these values with your Firebase project config

// Initialize Firebase app

// Initialize and export Firestore database
// Configurazione Firebase per uso con CDN (incluso in index.html)
var firebaseConfig = {
  apiKey: "AIzaSyBbS8KHnJewqmDkCPkTpWOudiQz62CMmMU",
  authDomain: "todo-list-e14cb.firebaseapp.com",
  projectId: "todo-list-e14cb",
  storageBucket: "todo-list-e14cb.firebasestorage.app",
  messagingSenderId: "163171617012",
  appId: "1:163171617012:web:928e02fd5a2c4fe6a536a1"
};

// Inizializza Firebase solo se non già inizializzato
if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
// Inizializza il servizio Auth (v8 compat) per usare firebase.auth()
if (firebase && firebase.auth) {
  firebase.auth();
}