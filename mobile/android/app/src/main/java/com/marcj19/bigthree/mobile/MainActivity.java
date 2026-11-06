package com.marcj19.bigthree.mobile;

import android.app.Activity;
import android.annotation.SuppressLint;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final int BACKGROUND = Color.rgb(23, 24, 28);
    private static final int SURFACE = Color.rgb(35, 37, 44);
    private static final int TEXT = Color.rgb(245, 245, 248);
    private static final int MUTED = Color.rgb(179, 184, 199);
    private static final int REFRESH_MS = 4000;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Runnable refresh = this::refresh;
    private DesktopConnection connection;
    private DesktopConnection.Session session;
    private LinearLayout body;
    private ScrollView scroll;
    private TextView status;
    private String conversation;
    private String lastEtag;
    private int generation;
    private boolean foreground;
    private boolean refreshing;
    private OnBackInvokedCallback backToList;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        connection = new DesktopConnection(this);
        buildLayout();
        network.execute(() -> {
            DesktopConnection.Session restored = null;
            try { restored = connection.restore(); } catch (Exception ignored) { connection.forget(); }
            DesktopConnection.Session result = restored;
            runOnUiThread(() -> {
                if (isDestroyed()) return;
                session = result;
                if (session == null) showPairing("Conecte ao seu PC");
                else select(null);
            });
        });
    }

    @Override protected void onResume() { super.onResume(); foreground = true; refresh(); }
    @Override protected void onPause() { foreground = false; handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() { handler.removeCallbacks(refresh); network.shutdownNow(); super.onDestroy(); }

    @SuppressLint("GestureBackNavigation") // Android 12 and older use this callback.
    @Override public void onBackPressed() {
        if (session != null && conversation != null) select(null);
        else super.onBackPressed();
    }

    private void updateBackAction(boolean inConversation) {
        if (android.os.Build.VERSION.SDK_INT < 33) return;
        OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
        if (inConversation && backToList == null) {
            backToList = () -> select(null);
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backToList);
        } else if (!inConversation && backToList != null) {
            dispatcher.unregisterOnBackInvokedCallback(backToList);
            backToList = null;
        }
    }

    private void buildLayout() {
        LinearLayout root = column();
        root.setBackgroundColor(BACKGROUND);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        }
        LinearLayout header = new LinearLayout(this);
        header.setGravity(android.view.Gravity.CENTER_VERTICAL);
        header.setPadding(dp(20), dp(12), dp(20), dp(10));
        ImageView brand = new ImageView(this);
        brand.setImageResource(R.drawable.big_three);
        brand.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(brand, dp(32), dp(32));
        TextView name = text("Big Three", 22, TEXT, true);
        name.setPadding(dp(10), 0, 0, 0);
        header.addView(name);
        root.addView(header);
        status = text("Carregando…", 14, MUTED, false);
        status.setPadding(dp(20), 0, dp(20), dp(10));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status);
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        body = column();
        body.setPadding(dp(20), 0, dp(20), dp(18));
        scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
    }

    private void showPairing(String message) {
        updateBackAction(false);
        status.setText(message);
        body.removeAllViews();
        heading("Parear com o computador");
        body.addView(text("No PC, abra Acesso pelo celular e gere um token. No Android, conecte-se à mesma rede Tailscale e use o endereço HTTPS do computador.", 16, MUTED, false));
        EditText endpoint = new EditText(this);
        endpoint.setHint("https://seu-pc.…ts.net");
        endpoint.setContentDescription("Endereço HTTPS do computador");
        endpoint.setSingleLine(true);
        endpoint.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        endpoint.setText(connection.previousEndpoint());
        body.addView(endpoint);
        EditText code = new EditText(this);
        code.setHint("Token gerado no PC");
        code.setContentDescription("Token de pareamento");
        code.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        code.setSingleLine(true);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        body.addView(code);
        Button pair = button("Parear", null);
        body.addView(pair);
        pair.setOnClickListener(view -> {
            String address = endpoint.getText().toString().trim();
            String token = code.getText().toString().trim();
            pair.setEnabled(false);
            status.setText("Pareando…");
            network.execute(() -> {
                try {
                    DesktopConnection.Session result = connection.pair(address, token);
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        session = result;
                        select(null);
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        status.setText(messageFor(error));
                        pair.setEnabled(true);
                    });
                }
            });
        });
    }

    private void select(String id) {
        updateBackAction(id != null);
        conversation = id;
        generation++;
        lastEtag = null;
        body.removeAllViews();
        status.setText("Consultando o PC…");
        scroll.scrollTo(0, 0);
        refresh();
    }

    private void refresh() {
        handler.removeCallbacks(refresh);
        if (!foreground || session == null || refreshing || isDestroyed()) return;
        refreshing = true;
        DesktopConnection.Session credential = session;
        int request = generation;
        String etag = lastEtag;
        String route = conversation == null ? "/v1/conversations" : "/v1/conversations/" + conversation;
        network.execute(() -> {
            try {
                DesktopConnection.Snapshot result = connection.read(credential, route, etag);
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (request == generation) {
                        if (!status.getText().toString().equals("Conectado ao PC")) status.setText("Conectado ao PC");
                        if (result.data() != null) {
                            lastEtag = result.etag();
                            render(result.data());
                        }
                    }
                    schedule(request);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (request == generation && error instanceof DesktopConnection.Rejected) {
                        connection.forget();
                        session = null;
                        showPairing(error.getMessage());
                    } else if (request == generation) {
                        String message = messageFor(error);
                        if (!status.getText().toString().equals(message)) status.setText(message);
                        if (body.getChildCount() == 0) {
                            if (conversation != null) body.addView(button("Voltar às conversas", () -> select(null)));
                            else body.addView(button("Parear novamente", this::disconnect));
                        }
                    }
                    schedule(request);
                });
            }
        });
    }

    private void schedule(int request) {
        refreshing = false;
        if (foreground && session != null) handler.postDelayed(refresh, request == generation ? REFRESH_MS : 0);
    }

    private void disconnect() {
        generation++;
        connection.forget();
        session = null;
        handler.removeCallbacks(refresh);
        showPairing("Conecte ao seu PC");
    }

    private void render(JSONObject result) {
        int scrollY = scroll.getScrollY();
        body.removeAllViews();
        if (conversation == null) {
            heading("Conversas");
            JSONArray list = result.optJSONArray("conversations");
            for (int i = 0; list != null && i < list.length(); i++) {
                JSONObject item = list.optJSONObject(i);
                if (item == null) continue;
                String id = item.optString("id");
                if (!id.matches("[0-9a-f-]{36}")) continue;
                String label = item.optString("title", "Conversa") + (item.optBoolean("running") ? " · Em execução" : "");
                body.addView(button(label, () -> select(id)));
            }
            if (list == null || list.length() == 0) body.addView(text("Nenhuma conversa no PC.", 16, MUTED, false));
            body.addView(button("Esquecer este PC", this::disconnect));
        } else {
            body.addView(button("Voltar às conversas", () -> select(null)));
            heading(result.optString("title", "Conversa"));
            JSONObject activity = result.optJSONObject("activity");
            if (activity != null) {
                heading("Atividade · " + label(activity.optString("status")));
                JSONArray events = activity.optJSONArray("entries");
                for (int i = events == null ? -1 : events.length() - 1; i >= 0; i--) {
                    JSONObject event = events.optJSONObject(i);
                    if (event != null) card(event.optString("label"), actor(event.optString("provider")) + label(event.optString("status")));
                }
            }
            heading("Mensagens recentes");
            JSONArray messages = result.optJSONArray("messages");
            for (int i = messages == null ? -1 : messages.length() - 1; i >= 0; i--) {
                JSONObject message = messages.optJSONObject(i);
                if (message != null) card(message.optString("text"), label(message.optString("author")));
            }
            if (messages == null || messages.length() == 0) body.addView(text("Nenhuma mensagem nesta conversa.", 16, MUTED, false));
        }
        scroll.post(() -> scroll.scrollTo(0, scrollY));
    }

    private static String actor(String value) { return value.isEmpty() ? "" : label(value) + " · "; }

    private static String label(String value) {
        return switch (value) {
            case "claude" -> "Claude";
            case "gemini" -> "Gemini";
            case "codex" -> "Codex";
            case "user" -> "Você";
            case "system" -> "Big Three";
            case "running" -> "Em execução";
            case "ok", "done" -> "Concluída";
            case "error" -> "Com erro";
            case "cancelled" -> "Cancelada";
            case "skipped" -> "Ignorada";
            default -> value;
        };
    }

    private static String messageFor(Exception error) {
        if (error instanceof IllegalArgumentException || error instanceof DesktopConnection.Rejected || error instanceof DesktopConnection.PrivateNetworkRequired) return error.getMessage();
        return "Não foi possível alcançar o PC. Confira o endereço, o Tailscale e se o Big Three está aberto.";
    }

    private void card(String title, String metadata) {
        LinearLayout card = column();
        GradientDrawable background = new GradientDrawable();
        background.setColor(SURFACE);
        background.setCornerRadius(dp(12));
        card.setBackground(background);
        card.setPadding(dp(14), dp(10), dp(14), dp(12));
        card.addView(text(metadata, 13, MUTED, true));
        TextView value = text(title, 16, TEXT, false);
        value.setTextIsSelectable(true);
        card.addView(value);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(8);
        body.addView(card, params);
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private void heading(String value) {
        TextView heading = text(value, 20, TEXT, true);
        heading.setPadding(0, dp(12), 0, dp(8));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        body.addView(heading);
    }

    private Button button(String value, Runnable action) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        if (action != null) button.setOnClickListener(view -> action.run());
        return button;
    }

    private TextView text(String value, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
