package com.marcj19.bigthree.mobile;

import android.app.Activity;
import android.app.AlertDialog;
import android.annotation.SuppressLint;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.text.InputFilter;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.ArrayAdapter;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Consumer;

public final class MainActivity extends Activity {
    private static final int REFRESH_MS = 4000;
    private static final DateTimeFormatter TIME = DateTimeFormatter.ofPattern("HH:mm", Locale.ROOT).withZone(ZoneId.systemDefault());
    private int background, surface, outline, ink, muted, accent, accentSurface, accentText, good, bad;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final Runnable refresh = this::refresh;
    private DesktopConnection connection;
    private DesktopConnection.Session session;
    private LinearLayout body;
    private LinearLayout footer;
    private LinearLayout sectionBar;
    private LinearLayout officeRows;
    private OfficeView officeView;
    private ScrollView scroll;
    private TextView status;
    private TextView connectionBadge;
    private String conversation;
    private String lastEtag;
    private JSONObject currentSnapshot;
    private boolean officeTab;
    private boolean activityTab;
    private boolean connected;
    private String sectionKey = "";
    private String footerKey = "";
    private int generation;
    private boolean foreground;
    private boolean refreshing;
    private boolean submitting;
    private String promptDraft = "";
    private OnBackInvokedCallback backToList;

    @Override public void onCreate(Bundle savedState) {
        super.onCreate(savedState);
        background = getColor(R.color.mobile_background);
        surface = getColor(R.color.mobile_surface);
        outline = getColor(R.color.mobile_outline);
        ink = getColor(R.color.mobile_text);
        muted = getColor(R.color.mobile_muted);
        accent = getColor(R.color.mobile_accent);
        accentSurface = getColor(R.color.mobile_accent_surface);
        accentText = getColor(R.color.mobile_accent_text);
        good = getColor(R.color.mobile_good);
        bad = getColor(R.color.mobile_bad);
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

    @Override protected void onResume() { super.onResume(); foreground = true; syncOfficeMotion(); refresh(); }
    @Override protected void onPause() { foreground = false; syncOfficeMotion(); handler.removeCallbacks(refresh); super.onPause(); }
    @Override protected void onDestroy() {
        handler.removeCallbacks(refresh);
        network.shutdownNow();
        if (officeView != null) officeView.dispose();
        super.onDestroy();
    }

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
        root.setBackgroundColor(background);
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        }
        LinearLayout header = row();
        header.setPadding(dp(20), dp(12), dp(20), dp(12));
        header.setBackgroundColor(surface);
        ImageView brand = new ImageView(this);
        brand.setImageResource(R.drawable.big_three);
        brand.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(brand, dp(34), dp(34));
        TextView name = text("Big Three", 20, ink, true);
        name.setPadding(dp(10), 0, 0, 0);
        header.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        connectionBadge = text("Conectando", 12, muted, true);
        connectionBadge.setPadding(dp(10), dp(6), dp(10), dp(6));
        connectionBadge.setBackground(shape(background, 20, outline));
        header.addView(connectionBadge);
        root.addView(header);
        View divider = new View(this);
        divider.setBackgroundColor(outline);
        root.addView(divider, -1, dp(1));
        status = text("Carregando…", 14, muted, false);
        status.setPadding(dp(20), dp(10), dp(20), dp(6));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(status);
        sectionBar = column();
        sectionBar.setPadding(dp(16), dp(8), dp(16), dp(8));
        sectionBar.setBackgroundColor(surface);
        sectionBar.setVisibility(View.GONE);
        root.addView(sectionBar);
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);
        body = column();
        body.setPadding(dp(18), dp(12), dp(18), dp(16));
        scroll.addView(body);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
        footer = column();
        footer.setBackgroundColor(surface);
        footer.setPadding(dp(16), dp(8), dp(16), dp(8));
        footer.setVisibility(View.GONE);
        footerKey = "";
        root.addView(footer);
        setContentView(root);
    }

    private void showPairing(String message) {
        updateBackAction(false);
        conversation = null;
        currentSnapshot = null;
        promptDraft = "";
        setConnection(message, false);
        connectionBadge.setText("Sem pareamento");
        footer.setVisibility(View.GONE);
        sectionBar.setVisibility(View.GONE);
        sectionKey = "";
        syncOfficeMotion();
        body.removeAllViews();
        heading("Conecte seu PC", 26);
        body.addView(text("Pareie o Android para acompanhar conversas, enviar prompts e ver sua equipe trabalhando.", 15, muted, false));
        LinearLayout form = column();
        form.setPadding(dp(16), dp(16), dp(16), dp(16));
        form.setBackground(shape(surface, 16, outline));
        form.addView(text("Token de pareamento", 16, ink, true));
        block(form, text("No PC, abra Acesso pelo celular e toque em Gerar token.", 14, muted, false), 6);
        EditText code = new EditText(this);
        code.setHint("Token gerado no PC");
        code.setContentDescription("Token de pareamento");
        code.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        code.setSingleLine(true);
        code.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        code.setPadding(dp(12), dp(12), dp(12), dp(12));
        code.setBackground(shape(background, 10, outline));
        block(form, code, 14);
        Button pair = action("Parear", true, null);
        block(form, pair, 12);
        block(body, form, 20);
        pair.setOnClickListener(view -> {
            String token = code.getText().toString().trim();
            pair.setEnabled(false);
            setConnection("Pareando…", false);
            network.execute(() -> {
                try {
                    DesktopConnection.Session result = connection.pair(token);
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        session = result;
                        select(null);
                    });
                } catch (Exception error) {
                    runOnUiThread(() -> {
                        if (isDestroyed()) return;
                        setConnection(messageFor(error), false);
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
        currentSnapshot = null;
        activityTab = false;
        promptDraft = "";
        body.removeAllViews();
        setConnection("Consultando o PC…", false);
        syncOfficeMotion();
        renderFooter();
        renderSectionBar();
        scroll.scrollTo(0, 0);
        refresh();
    }

    private void refresh() {
        handler.removeCallbacks(refresh);
        if (!foreground || session == null || refreshing || submitting || isDestroyed()) return;
        refreshing = true;
        DesktopConnection.Session credential = session;
        int request = generation;
        String etag = lastEtag;
        String selected = conversation;
        network.execute(() -> {
            try {
                DesktopConnection.Snapshot result = connection.read(credential, selected, etag);
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    if (request == generation) {
                        setConnection("", true);
                        if (result.data() != null) {
                            lastEtag = result.etag();
                            currentSnapshot = result.data();
                            render(currentSnapshot, false);
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
                        setConnection(message, false);
                        syncOfficeMotion();
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

    private void render(JSONObject result, boolean resetScroll) {
        renderSectionBar();
        renderFooter();
        if (conversation == null && officeTab && officeRows != null && officeView.getParent() == body && !resetScroll) {
            updateOffice(result.optJSONArray("office"));
            return;
        }
        int scrollY = scroll.getScrollY();
        boolean followChat = conversation != null && !activityTab && (resetScroll || !scroll.canScrollVertically(1));
        body.removeAllViews();
        if (conversation == null) {
            if (officeTab) renderOffice(result.optJSONArray("office"));
            else renderConversations(result.optJSONArray("conversations"));
        } else if (activityTab) {
            renderActivity(result.optJSONObject("activity"));
        } else {
            renderMessages(result.optJSONArray("messages"));
        }
        syncOfficeMotion();
        scroll.post(() -> {
            if (followChat) scroll.scrollTo(0, body.getHeight());
            else scroll.scrollTo(0, resetScroll ? 0 : scrollY);
        });
    }

    private void renderSectionBar() {
        if (conversation == null || session == null) {
            sectionBar.setVisibility(View.GONE);
            sectionKey = "";
            return;
        }
        String title = currentSnapshot == null ? "Conversa" : currentSnapshot.optString("title", "Conversa");
        String key = activityTab + ":" + title;
        if (key.equals(sectionKey)) return;
        sectionKey = key;
        sectionBar.removeAllViews();
        sectionBar.setVisibility(View.VISIBLE);
        LinearLayout header = row();
        Button back = action("‹", false, () -> select(null));
        back.setContentDescription("Voltar");
        back.setTextSize(26);
        header.addView(back, dp(48), dp(46));
        TextView name = text(title, 18, ink, true);
        name.setMaxLines(2);
        name.setEllipsize(TextUtils.TruncateAt.END);
        name.setPadding(dp(10), 0, 0, 0);
        if (android.os.Build.VERSION.SDK_INT >= 28) name.setAccessibilityHeading(true);
        header.addView(name, new LinearLayout.LayoutParams(0, -2, 1));
        sectionBar.addView(header);
        block(sectionBar, tabs("Conversa", "Atividade", activityTab, (second) -> {
            activityTab = second;
            if (currentSnapshot != null) render(currentSnapshot, true);
        }), 8);
    }

    private void renderFooter() {
        String permit = conversation == null || currentSnapshot == null ? "" : currentSnapshot.optString("promptPermit", "");
        boolean busy = conversation != null && currentSnapshot != null && currentSnapshot.optBoolean("busy");
        String key = session == null ? "pairing" : conversation == null ? "home:" + officeTab
            : conversation + ":" + (currentSnapshot != null) + ":" + permit + ":" + busy + ":" + connected;
        if (key.equals(footerKey)) return;
        footerKey = key;
        footer.removeAllViews();
        footer.setVisibility(session == null || (conversation != null && currentSnapshot == null) ? View.GONE : View.VISIBLE);
        if (session == null) return;
        if (conversation == null) {
            footer.addView(tabs("Conversas", "Escritório", officeTab, (second) -> {
                officeTab = second;
                syncOfficeMotion();
                if (currentSnapshot != null) render(currentSnapshot, true);
            }));
        } else if (currentSnapshot != null) {
            if (permit.isEmpty()) {
                TextView hint = text("Envio de prompts disponível quando autorizado no PC.", 13, muted, false);
                hint.setPadding(dp(8), dp(6), dp(8), dp(6));
                footer.addView(hint);
            } else {
                Button send = action(busy ? "Execução em andamento no PC" : "Escrever prompt", true, () -> promptDialog(permit));
                send.setEnabled(!busy && connected);
                footer.addView(send, -1, -2);
            }
        }
    }

    private void renderConversations(JSONArray list) {
        heading("Conversas", 26);
        int active = 0;
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item != null && item.optBoolean("running")) active++;
        }
        body.addView(text(active == 0 ? "Nenhuma execução no momento" : active + (active == 1 ? " execução em andamento" : " execuções em andamento"), 14, active > 0 ? good : muted, false));
        for (int i = 0; list != null && i < list.length(); i++) {
            JSONObject item = list.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id");
            if (!validConversation(id)) continue;
            boolean running = item.optBoolean("running");
            String time = displayTime(item.optString("updatedAt"));
            addRow(item.optString("title", "Conversa"), running ? "Em execução" : time, running ? good : muted, running ? "●" : "·", () -> select(id));
        }
        if (list == null || list.length() == 0) {
            addRow("Nenhuma conversa ainda", "Crie uma conversa no Big Three do PC.", muted, "·", null);
        }
        block(body, action("Desconectar este celular", false, () -> new AlertDialog.Builder(this).setTitle("Desconectar este celular?")
            .setMessage("Você pode parear novamente pelo PC.").setNegativeButton("Cancelar", null)
            .setPositiveButton("Desconectar", (dialog, which) -> disconnect()).show()), 18);
    }

    private void renderMessages(JSONArray messages) {
        if (messages == null || messages.length() == 0) {
            addRow("Nenhuma mensagem nesta conversa", "As mensagens do PC aparecem aqui.", muted, "·", null);
            return;
        }
        for (int i = 0; i < messages.length(); i++) {
            JSONObject message = messages.optJSONObject(i);
            if (message == null) continue;
            String author = message.optString("author");
            messageCard(message.optString("text"), label(author), displayTime(message.optString("at")), author.equals("user"));
        }
    }

    private void renderActivity(JSONObject activity) {
        if (activity == null) {
            addRow("Nenhuma execução nesta conversa", "A atividade da equipe aparece aqui.", muted, "·", null);
            return;
        }
        String state = activity.optString("status");
        heading("Última execução", 19);
        body.addView(text(label(state), 14, statusColor(state), true));
        JSONArray entries = activity.optJSONArray("entries");
        for (int i = entries == null ? -1 : entries.length() - 1; i >= 0; i--) {
            JSONObject entry = entries.optJSONObject(i);
            if (entry == null) continue;
            String stepState = entry.optString("status");
            String actor = entry.optString("provider", "");
            String time = displayTime(entry.optString("at"));
            String metadata = (actor.isEmpty() ? "" : label(actor) + " · ") + label(stepState) + (time.isEmpty() ? "" : " · " + time);
            addRow(entry.optString("label"), metadata, statusColor(stepState), stepState.equals("running") ? "●" : "·", null);
        }
    }

    private void renderOffice(JSONArray agents) {
        heading("Escritório", 26);
        body.addView(text("Acompanhe o que cada IA está fazendo no PC.", 14, muted, false));
        if (officeView == null) officeView = new OfficeView(this, dp(18));
        LinearLayout.LayoutParams scene = new LinearLayout.LayoutParams(-1, dp(260));
        scene.topMargin = dp(14);
        body.addView(officeView, scene);
        block(body, text("Arraste para girar · Use dois dedos para aproximar", 12, muted, false), 8);
        officeRows = column();
        block(body, officeRows, 4);
        updateOffice(agents);
    }

    private void updateOffice(JSONArray agents) {
        officeView.showAgents(agents);
        officeRows.removeAllViews();
        if (agents == null) {
            officeRows.addView(text("Atualize o Big Three do PC para ver a atividade da equipe.", 14, muted, false));
            return;
        }
        for (int i = 0; i < agents.length(); i++) {
            JSONObject agent = agents.optJSONObject(i);
            if (agent == null) continue;
            String id = agent.optString("id");
            if (!id.equals("claude") && !id.equals("gemini") && !id.equals("codex")) continue;
            String activeConversation = agent.optString("conversationId", "");
            String name = agent.optString("conversation", "");
            String description = agent.optString("label", "Aguardando") + (name.isEmpty() ? "" : "\n" + name);
            addRow(officeRows, label(id), description, agent.optString("status").equals("idle") ? muted : good,
                label(id).substring(0, 1), validConversation(activeConversation) ? () -> select(activeConversation) : null);
        }
    }

    private void syncOfficeMotion() {
        if (officeView != null) officeView.setPaused(!foreground || !connected || session == null || conversation != null || !officeTab);
    }

    private void setConnection(String message, boolean online) {
        if (!TextUtils.equals(status.getText(), message)) status.setText(message);
        status.setVisibility(message.isEmpty() ? View.GONE : View.VISIBLE);
        String label = online ? "PC conectado" : "PC indisponível";
        if (!TextUtils.equals(connectionBadge.getText(), label)) connectionBadge.setText(label);
        connectionBadge.setTextColor(online ? good : muted);
        if (connected == online) return;
        connected = online;
        syncOfficeMotion();
        renderFooter();
    }

    private void promptDialog(String permit) {
        if (session == null || conversation == null) return;
        DesktopConnection.Session target = session;
        String selected = conversation;
        String[] providers = { "claude", "gemini", "codex" };
        LinearLayout form = column();
        form.setPadding(dp(20), 0, dp(20), dp(12));
        form.addView(text("Modelo · solicitação em somente leitura", 14, muted, false));
        Spinner model = new Spinner(this);
        model.setContentDescription("Modelo");
        ArrayAdapter<String> choices = new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, new String[] { "Claude", "Gemini", "Codex" });
        model.setAdapter(choices);
        form.addView(model);
        EditText prompt = new EditText(this);
        prompt.setHint("O que você quer pedir?");
        prompt.setContentDescription("Prompt");
        prompt.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        prompt.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        prompt.setFilters(new InputFilter[] { new InputFilter.LengthFilter(2000) });
        prompt.setText(promptDraft);
        prompt.setMinLines(3);
        form.addView(prompt);
        TextView notice = text("", 14, muted, false);
        notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        form.addView(notice);
        AlertDialog dialog = new AlertDialog.Builder(this).setTitle("Enviar prompt ao PC").setView(form)
            .setNegativeButton("Fechar", null).setPositiveButton("Enviar", null).create();
        dialog.show();
        Button send = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
        final String[] previous = { null, null, null };
        dialog.setOnDismissListener(ignored -> {
            if (!submitting && conversation != null && conversation.equals(selected)) promptDraft = prompt.getText().toString();
        });
        send.setOnClickListener(view -> {
            String message = prompt.getText().toString().trim();
            if (message.isEmpty()) { notice.setText("Escreva um prompt para enviar."); return; }
            String provider = providers[model.getSelectedItemPosition()];
            if (!message.equals(previous[0]) || !provider.equals(previous[1])) {
                previous[0] = message; previous[1] = provider; previous[2] = UUID.randomUUID().toString();
            }
            String exchange = previous[2];
            submitting = true;
            send.setEnabled(false);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(false);
            dialog.setCancelable(false);
            notice.setText("Enviando ao PC…");
            network.execute(() -> {
                Exception error = null;
                try { connection.sendPrompt(target, selected, permit, provider, message, exchange); }
                catch (Exception rejected) { error = rejected; }
                Exception result = error;
                runOnUiThread(() -> {
                    submitting = false;
                    if (isDestroyed()) return;
                    if (result == null) {
                        prompt.setText("");
                        promptDraft = "";
                        dialog.dismiss();
                        Toast.makeText(this, "Prompt enviado ao PC", Toast.LENGTH_SHORT).show();
                    } else if (dialog.isShowing()) {
                        notice.setText(messageFor(result));
                        dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setEnabled(true);
                        dialog.setCancelable(true);
                        send.setEnabled(!(result instanceof DesktopConnection.PromptRefused));
                    }
                    refresh();
                });
            });
        });
    }

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
        if (error instanceof IllegalArgumentException || error instanceof DesktopConnection.Rejected || error instanceof DesktopConnection.Offline || error instanceof DesktopConnection.PromptRefused) return error.getMessage();
        return "Não foi possível se conectar ao Big Three. Confira sua internet e se o app do PC está aberto.";
    }

    private void messageCard(String title, String author, String time, boolean user) {
        LinearLayout card = column();
        card.setBackground(shape(user ? accentSurface : surface, 16, user ? 0 : outline));
        card.setPadding(dp(15), dp(12), dp(15), dp(14));
        LinearLayout meta = row();
        meta.addView(text(author, 13, user ? accentText : ink, true), new LinearLayout.LayoutParams(0, -2, 1));
        meta.addView(text(time, 12, muted, false));
        card.addView(meta);
        TextView value = text(title, 15, ink, false);
        value.setLineSpacing(dp(4), 1f);
        value.setTextIsSelectable(true);
        block(card, value, 7);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.bottomMargin = dp(10);
        if (user) params.setMarginStart(dp(20)); else params.setMarginEnd(dp(10));
        body.addView(card, params);
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private LinearLayout row() {
        LinearLayout layout = new LinearLayout(this);
        layout.setGravity(Gravity.CENTER_VERTICAL);
        return layout;
    }

    private void block(LinearLayout parent, View child, int top) {
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
        params.topMargin = dp(top);
        parent.addView(child, params);
    }

    private void addRow(String title, String caption, int color, String glyph, Runnable action) {
        addRow(body, title, caption, color, glyph, action);
    }

    private void addRow(LinearLayout parent, String title, String caption, int color, String glyph, Runnable action) {
        LinearLayout card = row();
        card.setPadding(dp(12), dp(12), dp(12), dp(12));
        card.setBackground(action == null ? shape(surface, 14, outline) : ripple(surface, 14, outline));
        TextView mark = text(glyph, 14, color, true);
        mark.setGravity(Gravity.CENTER);
        mark.setBackground(shape(background, 10, 0));
        mark.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        card.addView(mark, dp(38), dp(38));
        LinearLayout copy = column();
        copy.setPadding(dp(12), 0, dp(6), 0);
        TextView titleView = text(title, 15, ink, true);
        titleView.setMaxLines(2);
        titleView.setEllipsize(TextUtils.TruncateAt.END);
        copy.addView(titleView);
        if (!caption.isEmpty()) block(copy, text(caption, 13, color, false), 4);
        card.addView(copy, new LinearLayout.LayoutParams(0, -2, 1));
        if (action != null) {
            TextView chevron = text("›", 22, muted, false);
            chevron.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            card.addView(chevron);
            card.setFocusable(true);
            card.setContentDescription(caption.isEmpty() ? title : title + ", " + caption);
            card.setOnClickListener(view -> action.run());
        }
        block(parent, card, 8);
    }

    private void heading(String value, int size) {
        TextView heading = text(value, size, ink, true);
        heading.setPadding(0, dp(5), 0, dp(6));
        if (android.os.Build.VERSION.SDK_INT >= 28) heading.setAccessibilityHeading(true);
        body.addView(heading);
    }

    private Button button(String value, Runnable tap) {
        return action(value, false, tap);
    }

    private Button action(String value, boolean primary, Runnable tap) {
        Button button = new Button(this);
        button.setAllCaps(false);
        button.setText(value);
        button.setTextSize(14);
        button.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        button.setMinHeight(dp(46));
        button.setMinimumHeight(dp(46));
        button.setMinimumWidth(0);
        button.setMinWidth(0);
        button.setPadding(dp(12), dp(9), dp(12), dp(9));
        button.setBackgroundTintList(null);
        button.setStateListAnimator(null);
        button.setBackground(ripple(primary ? accent : surface, 12, primary ? 0 : outline));
        button.setTextColor(new ColorStateList(new int[][] { {-android.R.attr.state_enabled}, {} },
            new int[] { primary ? 0xCCFFFFFF : muted, primary ? Color.WHITE : ink }));
        if (tap != null) button.setOnClickListener(view -> tap.run());
        return button;
    }

    private LinearLayout tabs(String first, String second, boolean secondSelected, Consumer<Boolean> select) {
        LinearLayout tabs = row();
        tabs.setPadding(dp(3), dp(3), dp(3), dp(3));
        tabs.setBackground(shape(background, 14, outline));
        Button a = action(first, false, () -> select.accept(false));
        Button b = action(second, false, () -> select.accept(true));
        for (Button button : new Button[] { a, b }) {
            boolean selected = (button == b) == secondSelected;
            button.setSelected(selected);
            button.setBackground(ripple(selected ? accentSurface : background, 11, 0));
            button.setTextColor(selected ? accentText : muted);
            tabs.addView(button, new LinearLayout.LayoutParams(0, -2, 1));
        }
        return tabs;
    }

    private GradientDrawable shape(int color, int radius, int stroke) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        if (stroke != 0) drawable.setStroke(dp(1), stroke);
        return drawable;
    }

    private RippleDrawable ripple(int color, int radius, int stroke) {
        return new RippleDrawable(ColorStateList.valueOf(0x263F6EAB), shape(color, radius, stroke), shape(Color.WHITE, radius, 0));
    }

    private int statusColor(String state) {
        return state.equals("error") ? bad : state.equals("running") || state.equals("ok") ? good : muted;
    }

    private static boolean validConversation(String id) { return id.matches("[0-9a-f-]{36}"); }

    private static String displayTime(String value) {
        try { return TIME.format(Instant.parse(value)); } catch (RuntimeException ignored) { return ""; }
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
