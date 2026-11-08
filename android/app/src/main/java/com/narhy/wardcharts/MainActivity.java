package com.narhy.wardcharts;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  // "dose-due-alerts" — matches the channelId every drug-due/glucose-check
  // push sends in its android.notification block (see the comment on the
  // drug-due send in functions/index.js). Android requires a notification
  // channel to exist BEFORE a push naming it arrives, or the OS silently
  // falls back to an auto-created default channel with no guaranteed sound
  // or heads-up behavior — IMPORTANCE_HIGH here is what gives a locked/
  // backgrounded phone the heads-up banner + sound the alarm depends on.
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    createDoseDueAlertsChannel();
    enableWideViewport();
  }

  // The in-app "desktop mode" button swaps the page's viewport meta tag to a
  // wide 1100px canvas. Android WebView ignores a viewport width unless wide
  // viewport support is switched on, which is why the button did nothing in the
  // APK (it works in Chrome). Mobile mode still uses width=device-width, so the
  // normal phone layout is unaffected.
  private void enableWideViewport() {
    if (getBridge() == null) return;
    WebView webView = getBridge().getWebView();
    if (webView == null) return;
    WebSettings settings = webView.getSettings();
    settings.setUseWideViewPort(true);
    settings.setLoadWithOverviewMode(true);
    settings.setSupportZoom(true);
  }

  private void createDoseDueAlertsChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return; // channels are a 26+ concept

    NotificationChannel channel = new NotificationChannel(
        "dose-due-alerts",
        "Drug & Chart Due Alerts",
        NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Alerts when a drug dose, glucose check, or other chart entry is due.");
    channel.enableVibration(true);
    channel.setVibrationPattern(new long[]{400, 200, 400, 200, 400, 200, 400});

    NotificationManager manager = getSystemService(NotificationManager.class);
    if (manager != null) manager.createNotificationChannel(channel);
  }
}
