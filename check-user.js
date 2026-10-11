const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

async function main() {
  const user = await admin.auth().getUserByEmail(
    "siddharthsunil378@gmail.com"
  );

  console.log("Email:", user.email);
  console.log("Email verified:", user.emailVerified);
  console.log("Account disabled:", user.disabled);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
