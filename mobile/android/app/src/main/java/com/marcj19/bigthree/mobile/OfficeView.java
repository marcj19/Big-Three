package com.marcj19.bigthree.mobile;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceError;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

final class OfficeView extends FrameLayout {
    private static final String PAGE = "file:///android_asset/office.html";
    private WebView web;
    private String agents = "[]";
    private boolean ready;
    private boolean paused = true;

    @SuppressLint("SetJavaScriptEnabled") // One bundled, offline page, without a native JS bridge.
    OfficeView(Context context, int radius) {
        super(context);
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(235, 240, 232));
        background.setCornerRadius(radius);
        setBackground(background);
        setClipToOutline(true);
        TextView loading = new TextView(context);
        loading.setGravity(Gravity.CENTER);
        loading.setTextColor(Color.rgb(38, 56, 71));
        loading.setText("Carregando o escritório…");
        web = new WebView(context);
        web.setBackgroundColor(Color.TRANSPARENT);
        web.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        web.getSettings().setAllowFileAccess(false);
        web.getSettings().setAllowContentAccess(false);
        web.getSettings().setBlockNetworkLoads(true);
        web.getSettings().setJavaScriptEnabled(true);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return true; }
            @Override public void onPageCommitVisible(WebView view, String url) {
                if (PAGE.equals(url)) removeView(loading);
            }
            @Override public void onPageFinished(WebView view, String url) {
                ready = PAGE.equals(url);
                apply();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) loading.setText("O 3D está indisponível neste aparelho.");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                dispose();
                loading.setText("O 3D está indisponível neste aparelho.");
                if (loading.getParent() == null) addView(loading, new LayoutParams(-1, -1));
                return true;
            }
        });
        addView(web, new LayoutParams(-1, -1));
        addView(loading, new LayoutParams(-1, -1));
        web.loadUrl(PAGE);
    }

    void showAgents(JSONArray value) {
        agents = value == null ? "[]" : value.toString();
        apply();
    }

    void setPaused(boolean value) {
        if (paused == value || web == null) return;
        paused = value;
        if (paused) web.onPause(); else web.onResume();
        apply();
    }

    private void apply() {
        if (!ready || web == null) return;
        web.evaluateJavascript("window.bigThreeOffice?.(" + JSONObject.quote(agents) + ");window.bigThreePause?.(" + paused + ");", null);
    }

    void dispose() {
        if (web == null) return;
        removeView(web);
        web.destroy();
        web = null;
        ready = false;
    }
}
