package app.seniordirectory.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.seniordirectory.Brand
import kotlinx.coroutines.delay

/**
 * Full-screen just-in-time safety prompt. For dialable brands, a 3-second delay precedes
 * the call button; for online-only brands it shows the no-phone-support warning instead.
 */
@Composable
fun SafetyPromptScreen(brand: Brand, onDismiss: () -> Unit, onCall: () -> Unit) {
    val dialable = brand.isDialable
    var remaining by remember(brand.id) { mutableIntStateOf(if (dialable) 3 else 0) }
    LaunchedEffect(brand.id) {
        while (remaining > 0) {
            delay(1000)
            remaining -= 1
        }
    }

    Box(
        modifier = Modifier.fillMaxSize().background(Color(0xFF14213D)).padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Text(if (dialable) "⚠️" else "✋", fontSize = 64.sp)
            Text(brand.name, color = Color.White, fontSize = 30.sp, fontWeight = FontWeight.Bold)
            Text(brand.safetyWarning, color = Color.White, fontSize = 22.sp, textAlign = TextAlign.Center)

            if (dialable) {
                Button(
                    onClick = onCall,
                    enabled = remaining == 0,
                    modifier = Modifier.fillMaxWidth().height(64.dp),
                ) {
                    Text(
                        if (remaining == 0) "Call ${brand.phoneDisplay}" else "Please wait… $remaining",
                        fontSize = 22.sp, fontWeight = FontWeight.Bold,
                    )
                }
            } else {
                Text(
                    "This company has no support phone line. Anyone who gives you one is a scammer.",
                    color = Color(0xFFFFD60A), fontSize = 20.sp,
                    fontWeight = FontWeight.Bold, textAlign = TextAlign.Center,
                )
            }
            TextButton(onClick = onDismiss) { Text("Go back", color = Color.White, fontSize = 20.sp) }
        }
    }
}
