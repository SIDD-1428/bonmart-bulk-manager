const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

async function main() {
  const email = "bonmart2026@gmail.com";
  const user = await admin.auth().getUserByEmail(email);

  console.log("Email:", user.email);
  console.log("Currently verified:", user.emailVerified);

  if (!user.emailVerified) {
    await admin.auth().updateUser(user.uid, { emailVerified: true });
    console.log("Email verified successfully!");
  } else {
    console.log("This email is already verified.");
  }
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
