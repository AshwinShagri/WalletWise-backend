const { db, admin } = require("../config/firebaseAdmin");

exports.loginUser = async (req, res) => {
    try {
        const { uid, displayName, email } = req.body;
        const usersRef = db.collection("users").doc(uid);
        const userDoc = await usersRef.get();

        if (!userDoc.exists) {
            // Pick a random avatar from the local `public/avatars/` folder
            const randomAvatar = `/avatars/${Math.floor(Math.random() * 20) + 1}.png`;

            await usersRef.set({
                name: displayName || "User",
                email: email || "",
                avatar: randomAvatar, // ✅ Local avatar path
                currency: "INR (₹)", // ✅ Default currency
                theme: "light", // ✅ Default theme
            });
        }

        res.status(200).json({ message: "User logged in" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
