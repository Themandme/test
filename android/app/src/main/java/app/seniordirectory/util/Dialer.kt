package app.seniordirectory.util

import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Opens the native dialer pre-filled with the number (ACTION_DIAL). The senior taps the
 * call button — no CALL_PHONE permission, mirroring iOS's tel: behavior.
 */
object Dialer {
    fun call(context: Context, phone: String) {
        val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }
}
