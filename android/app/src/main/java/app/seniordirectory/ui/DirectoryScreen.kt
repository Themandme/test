package app.seniordirectory.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.seniordirectory.AppState
import app.seniordirectory.Brand
import app.seniordirectory.util.Dialer

/** The main directory: panic button, local search, contacts, and the brand grid. */
@Composable
fun DirectoryScreen(state: AppState) {
    val context = LocalContext.current
    var selected by remember { mutableStateOf<Brand?>(null) }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().padding(16.dp)) {
            if (state.seniorName.isNotBlank()) {
                Text("Hello, ${state.seniorName}", fontSize = 28.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(8.dp))
            }
            state.emergencyContact?.let { contact ->
                PanicButton(contact) { Dialer.call(context, contact.phone) }
                Spacer(Modifier.height(12.dp))
            }
            SearchBar(state.search) { state.search = it }
            Spacer(Modifier.height(12.dp))

            LazyVerticalGrid(
                columns = GridCells.Fixed(2),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                if (state.customContacts.isNotEmpty() && state.search.isBlank()) {
                    item(span = { GridItemSpan(2) }) {
                        SectionHeader("Your contacts")
                    }
                    items(state.customContacts, span = { GridItemSpan(2) }) { contact ->
                        ContactButton(contact) { Dialer.call(context, contact.phone) }
                    }
                    item(span = { GridItemSpan(2) }) {
                        SectionHeader("National brands")
                    }
                }
                items(state.visibleBrands, key = { it.id }) { brand ->
                    BrandButton(brand) { selected = brand }
                }
            }
        }

        // Full-screen safety prompt drawn above the grid.
        selected?.let { brand ->
            SafetyPromptScreen(
                brand = brand,
                onDismiss = { selected = null },
                onCall = {
                    brand.phone?.let { Dialer.call(context, it) }
                    selected = null
                },
            )
        }
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, fontSize = 20.sp, fontWeight = FontWeight.Bold, modifier = Modifier.padding(top = 4.dp))
}
