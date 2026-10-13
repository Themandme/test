package app.seniordirectory.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.seniordirectory.AppState

/** Minimalist activation screen — the only job is to accept the 6-digit code. */
@Composable
fun ActivationScreen(state: AppState) {
    var code by remember { mutableStateOf("") }
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text("Safe Numbers", fontSize = 34.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Black)
        Spacer(Modifier.height(8.dp))
        Text(
            "Enter your 6-digit activation code",
            fontSize = 20.sp, color = Color.Gray, textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = code,
            onValueChange = { if (it.length <= 6 && it.all(Char::isDigit)) code = it },
            textStyle = LocalTextStyle.current.copy(fontSize = 32.sp, textAlign = TextAlign.Center),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(16.dp))
        state.activationError?.let {
            Text(it, color = Color(0xFFC01818), textAlign = TextAlign.Center)
            Spacer(Modifier.height(8.dp))
        }
        Button(
            onClick = { state.activate(code) },
            enabled = code.length == 6 && !state.isActivating,
            modifier = Modifier.fillMaxWidth().height(60.dp),
        ) {
            if (state.isActivating) {
                CircularProgressIndicator(modifier = Modifier.height(24.dp), color = Color.White, strokeWidth = 2.dp)
            } else {
                Text("Activate", fontSize = 22.sp, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold)
            }
        }
    }
}
