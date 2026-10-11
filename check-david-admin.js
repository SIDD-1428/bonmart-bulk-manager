const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault()
});

async function main() {
  const email = "poruthurdavid378@gmail.com";

  try {
    const user = await admin.auth().getUserByEmail(email);

    console.log("Email:", user.email);
    console.log("Email verified:", user.emailVerified);
    console.log("Account disabled:", user.disabled);

    if (!user.emailVerified) {
      console.log("This account needs email verification.");
    } else if (user.disabled) {
      console.log("This account is disabled.");
    } else {
      console.log("Account exists, is verified, and is enabled.");
    }
  } catch (error) {
    console.error("Firebase account lookup failed:", error.message);
  }
}

main();
