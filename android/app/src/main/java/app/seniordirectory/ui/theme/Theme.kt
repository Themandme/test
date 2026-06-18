package app.seniordirectory.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Parse "#RRGGBB" from the brand palette into a Compose Color. */
fun colorFromHex(hex: String): Color {
    val v = hex.removePrefix("#").toLong(16)
    return Color(
        red = ((v shr 16) and 0xFF) / 255f,
        green = ((v shr 8) and 0xFF) / 255f,
        blue = (v and 0xFF) / 255f,
        alpha = 1f,
    )
}

/** Scale a color toward black (factor < 1) for gradient depth. */
fun Color.darken(factor: Float): Color = Color(red * factor, green * factor, blue * factor, alpha)

private val LightColors = lightColorScheme(
    primary = Color(0xFF1F6FEB),
    background = Color(0xFFF6F8FC),
    surface = Color(0xFFFFFFFF),
)

@Composable
fun SeniorDirectoryTheme(content: @Composable () -> Unit) {
    // Light, high-contrast only — predictable for senior users.
    MaterialTheme(colorScheme = LightColors, content = content)
}
