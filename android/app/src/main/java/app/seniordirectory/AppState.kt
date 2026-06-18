package app.seniordirectory

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.seniordirectory.data.ApiClient
import app.seniordirectory.data.ApiException
import app.seniordirectory.data.LocalCache
import app.seniordirectory.data.SeedData
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

enum class Phase { Loading, NeedsActivation, Ready }

/**
 * App-wide state. Offline-first: loads from the local cache, then opportunistically
 * refreshes. Mirrors the iOS AppState.
 */
class AppState(app: Application) : AndroidViewModel(app) {

    private val cache = LocalCache(app)
    private val api = ApiClient(BuildConfig.API_BASE_URL)

    var phase by mutableStateOf(Phase.Loading)
        private set
    var brands by mutableStateOf<List<Brand>>(emptyList())
        private set
    var payload by mutableStateOf<ActivationPayload?>(null)
        private set
    var activationError by mutableStateOf<String?>(null)
        private set
    var isActivating by mutableStateOf(false)
        private set
    var search by mutableStateOf("")

    val emergencyContact: EmergencyContact? get() = payload?.emergencyContact
    val customContacts: List<CustomContact> get() = payload?.customContacts ?: emptyList()
    val seniorName: String get() = payload?.seniorProfile?.displayName ?: ""

    val visibleBrands: List<Brand>
        get() = if (search.isBlank()) brands else brands.filter {
            it.name.contains(search, ignoreCase = true) || it.category.contains(search, ignoreCase = true)
        }

    fun bootstrap() {
        viewModelScope.launch {
            val cachedBrands = withContext(Dispatchers.IO) { cache.loadBrands() }
            val cachedPayload = withContext(Dispatchers.IO) { cache.loadPayload() }

            brands = cachedBrands.ifEmpty {
                withContext(Dispatchers.IO) { SeedData.bundledBrands(getApplication()) }
            }
            if (cachedBrands.isEmpty() && brands.isNotEmpty()) {
                withContext(Dispatchers.IO) { cache.saveBrands(brands) }
            }

            payload = cachedPayload
            phase = if (cachedPayload == null) Phase.NeedsActivation else Phase.Ready
            refreshBrands()
        }
    }

    fun activate(code: String) {
        if (isActivating) return
        viewModelScope.launch {
            isActivating = true
            activationError = null
            try {
                val result = withContext(Dispatchers.IO) {
                    val publicKey = api.fetchSigningKey()
                    cache.savePublicKey(publicKey)
                    val p = api.activate(code, publicKey)
                    cache.savePayload(p)
                    if (cache.loadBrands().isEmpty()) {
                        cache.saveBrands(api.fetchBrands().brands)
                    }
                    p
                }
                payload = result
                brands = withContext(Dispatchers.IO) { cache.loadBrands() }.ifEmpty { brands }
                phase = Phase.Ready
            } catch (e: ApiException) {
                activationError = e.message ?: "Something went wrong. Please try again."
            } catch (e: Exception) {
                activationError = "Couldn’t reach the server. Check your connection and try again."
            } finally {
                isActivating = false
            }
        }
    }

    private suspend fun refreshBrands() {
        runCatching {
            val fresh = withContext(Dispatchers.IO) { api.fetchBrands().brands }
            if (fresh.isNotEmpty()) {
                brands = fresh
                withContext(Dispatchers.IO) { cache.saveBrands(fresh) }
            }
        }
    }
}
