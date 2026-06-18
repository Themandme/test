package app.seniordirectory.data

import android.content.Context
import app.seniordirectory.AppJson
import app.seniordirectory.Brand
import app.seniordirectory.BrandsResponse
import kotlinx.serialization.decodeFromString

/** Loads the bundled assets/brands.json so the 50 brands are usable on first launch. */
object SeedData {
    fun bundledBrands(context: Context): List<Brand> = runCatching {
        val text = context.assets.open("brands.json").bufferedReader().use { it.readText() }
        AppJson.decodeFromString<BrandsResponse>(text).brands
    }.getOrDefault(emptyList())
}
