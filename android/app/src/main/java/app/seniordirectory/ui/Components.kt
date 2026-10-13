package app.seniordirectory.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.seniordirectory.Brand
import app.seniordirectory.CustomContact
import app.seniordirectory.EmergencyContact
import app.seniordirectory.ui.theme.colorFromHex
import app.seniordirectory.ui.theme.darken

private val Radius = RoundedCornerShape(16.dp)

/** A national-brand tile: brand-colored gradient + a "Tap to call" / "No phone line" pill. */
@Composable
fun BrandButton(brand: Brand, onTap: () -> Unit) {
    val bg = colorFromHex(brand.brandColorHex)
    val fg = colorFromHex(brand.textColorHex)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 104.dp)
            .shadow(6.dp, Radius)
            .clip(Radius)
            .background(Brush.verticalGradient(listOf(bg, bg.darken(0.80f))))
            .border(1.dp, Color.White.copy(alpha = 0.18f), Radius)
            .clickable { onTap() }
            .padding(10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = brand.name,
            color = fg,
            fontSize = 22.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            maxLines = 2,
        )
        Spacer(Modifier.height(10.dp))
        StatusPill(brand.isDialable, fg)
    }
}

@Composable
private fun StatusPill(isDialable: Boolean, fg: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(fg.copy(alpha = 0.18f))
            .padding(horizontal = 10.dp, vertical = 5.dp),
    ) {
        Text(if (isDialable) "📞  Tap to call" else "⚠  No phone line",
            color = fg, fontSize = 14.sp, fontWeight = FontWeight.Bold)
    }
}

/** A saved local contact — dials directly (caregiver-entered, trusted). */
@Composable
fun ContactButton(contact: CustomContact, onCall: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clip(Radius)
            .background(Color(0xFFEFF1F5))
            .clickable { onCall() }
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(
            modifier = Modifier.size(48.dp).clip(CircleShape).background(Color(0x2600C853)),
            contentAlignment = Alignment.Center,
        ) { Text("📞", fontSize = 20.sp) }
        Column(Modifier.weight(1f)) {
            Text(contact.name, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(contact.category, fontSize = 16.sp, color = Color.Gray)
        }
        Text(contact.phoneDisplay, fontSize = 16.sp, color = Color.Gray)
    }
}

/** Feature #2 — the always-visible "Call My Person" panic button. */
@Composable
fun PanicButton(contact: EmergencyContact, onCall: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 80.dp)
            .shadow(8.dp, Radius)
            .clip(Radius)
            .background(Brush.verticalGradient(listOf(Color(0xFF34C759), Color(0xFF1F9E45))))
            .clickable { onCall() }
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Box(
            modifier = Modifier.size(54.dp).clip(CircleShape).background(Color.White.copy(alpha = 0.22f)),
            contentAlignment = Alignment.Center,
        ) { Text("📞", fontSize = 26.sp) }
        Column(Modifier.weight(1f)) {
            Text("Call ${contact.name}", color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
            Text(
                contact.relationship.replaceFirstChar { it.uppercase() },
                color = Color.White.copy(alpha = 0.95f),
                fontSize = 16.sp,
            )
        }
    }
}

/** Local-only search — filters the cached list instantly, never the web. */
@Composable
fun SearchBar(value: String, onChange: (String) -> Unit) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        placeholder = { Text("Search", fontSize = 20.sp) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
}
