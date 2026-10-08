package sbtbiswas.AidenOnTheGo.features.settings

import android.content.Context
import android.content.pm.PackageManager
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Gavel
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.PrivacyTip
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import sbtbiswas.AidenOnTheGo.R
import sbtbiswas.AidenOnTheGo.config.AppConfig

/** About: privacy policy, support, license, and the installed version. */
@Composable
fun AidenAboutSettingsScreen(onNavigateBack: () -> Unit) {
    val context = LocalContext.current
    val uriHandler = LocalUriHandler.current
    val version = remember(context) { installedVersion(context) }
    AidenSettingsScaffold(
        title = stringResource(R.string.settings_about),
        onNavigateBack = onNavigateBack
    ) {
        item(key = "about") {
            AidenSettingsGroup(title = AppConfig.DISPLAY_NAME) {
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.about_privacy_policy),
                        leadingIcon = Icons.Outlined.PrivacyTip,
                        onClick = { runCatching { uriHandler.openUri(AppConfig.PRIVACY_POLICY_URL) } }
                    )
                }
                row {
                    AidenSettingsNavigationRow(
                        headline = stringResource(R.string.about_support),
                        leadingIcon = Icons.AutoMirrored.Outlined.HelpOutline,
                        onClick = { runCatching { uriHandler.openUri(AppConfig.SUPPORT_URL) } }
                    )
                }
                row {
                    AidenSettingsValueRow(
                        headline = stringResource(R.string.about_license),
                        value = stringResource(R.string.about_license_value),
                        leadingIcon = Icons.Outlined.Gavel
                    )
                }
                row {
                    AidenSettingsValueRow(
                        headline = stringResource(R.string.about_version),
                        value = version,
                        leadingIcon = Icons.Outlined.Info
                    )
                }
            }
        }
    }
}

private fun installedVersion(context: Context): String? = try {
    context.packageManager.getPackageInfo(context.packageName, 0).versionName
} catch (_: PackageManager.NameNotFoundException) {
    null
}
