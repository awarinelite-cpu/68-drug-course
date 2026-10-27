import { doc, deleteDoc } from "firebase/firestore";
import { db } from "../firebase.js";

// Replaces the old deleteUserAccount Cloud Function. Deleting users/{uid}
// locks the person out of the app (they land on the "account isn't set up
// yet" screen), which firestore.rules already allows admins to do directly.
// The underlying Firebase Authentication account can't be removed from the
// browser — delete it in Firebase Console > Authentication if you want it gone.
export async function deleteUserProfile(uid, callerUid) {
  if (!uid) throw new Error("Missing user id.");
  if (uid === callerUid) throw new Error("You can't delete your own account.");
  await deleteDoc(doc(db, "users", uid));
}
