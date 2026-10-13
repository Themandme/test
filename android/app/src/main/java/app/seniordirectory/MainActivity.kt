package app.seniordirectory

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import app.seniordirectory.ui.ActivationScreen
import app.seniordirectory.ui.DirectoryScreen
import app.seniordirectory.ui.theme.SeniorDirectoryTheme

class MainActivity : ComponentActivity() {

    private val state: AppState by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        state.bootstrap()
        setContent {
            SeniorDirectoryTheme {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    when (state.phase) {
                        Phase.Loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator()
                        }
                        Phase.NeedsActivation -> ActivationScreen(state)
                        Phase.Ready -> DirectoryScreen(state)
                    }
                }
            }
        }
    }
}
