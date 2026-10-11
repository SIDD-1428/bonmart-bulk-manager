const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

async function main() {
  const email = "siddharthsunil378@gmail.com";
  const user = await admin.auth().getUserByEmail(email);

  if (user.emailVerified) {
    console.log("This email is already verified.");
    return;
  }

  await admin.auth().updateUser(user.uid, { emailVerified: true });
  console.log("Email verified successfully for:", email);
}

main().catch(err => {
  console.error("Error:", err.message);
  process.exitCode = 1;
});
