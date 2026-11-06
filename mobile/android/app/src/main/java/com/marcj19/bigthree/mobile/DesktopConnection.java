package com.marcj19.bigthree.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;

final class DesktopConnection {
    private static final String KEY_ALIAS = "big-three-desktop-session";
    private static final int IV_LENGTH = 12;
    private final SharedPreferences prefs;

    record Session(String endpoint, String credential) {}
    record Snapshot(JSONObject data, String etag) {}

    static final class Rejected extends IOException {
        Rejected() { super("Pareamento encerrado ou token inválido. Gere um novo token no PC."); }
    }

    static final class PrivateNetworkRequired extends IOException {
        PrivateNetworkRequired() { super("Conecte o Android ao Tailscale e confira se o PC está usando Tailscale Serve."); }
    }

    DesktopConnection(Context context) {
        prefs = context.getSharedPreferences("desktop-connection", Context.MODE_PRIVATE);
    }

    Session pair(String rawEndpoint, String code) throws Exception {
        String endpoint = endpoint(rawEndpoint);
        if (!code.matches("[A-Za-z0-9_-]{32}")) throw new IllegalArgumentException("Cole o token de pareamento gerado no PC.");
        JSONObject reply = request(endpoint, code, "/v1/pair", "POST", null).data();
        String credential = reply.getString("credential");
        if (!credential.matches("[A-Za-z0-9_-]{32}")) throw new IOException("Resposta de pareamento inválida.");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encoded = cipher.doFinal(credential.getBytes(StandardCharsets.UTF_8));
        byte[] packet = Arrays.copyOf(cipher.getIV(), IV_LENGTH + encoded.length);
        System.arraycopy(encoded, 0, packet, IV_LENGTH, encoded.length);
        prefs.edit().putString("endpoint", endpoint).putString("session", Base64.encodeToString(packet, Base64.NO_WRAP)).apply();
        return new Session(endpoint, credential);
    }

    Session restore() throws Exception {
        String endpoint = prefs.getString("endpoint", "");
        String saved = prefs.getString("session", null);
        if (saved == null) return null;
        byte[] packet = Base64.decode(saved, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, packet, 0, IV_LENGTH));
        String credential = new String(cipher.doFinal(packet, IV_LENGTH, packet.length - IV_LENGTH), StandardCharsets.UTF_8);
        return new Session(endpoint(endpoint), credential);
    }

    void forget() { prefs.edit().remove("session").apply(); }

    String previousEndpoint() { return prefs.getString("endpoint", ""); }

    Snapshot read(Session session, String route, String etag) throws Exception {
        return request(session.endpoint(), session.credential(), route, "GET", etag);
    }

    private static String endpoint(String value) {
        try {
            URI uri = URI.create(value.trim());
            if ("https".equalsIgnoreCase(uri.getScheme()) && uri.getHost() != null && uri.getHost().toLowerCase(java.util.Locale.ROOT).endsWith(".ts.net") && uri.getRawUserInfo() == null
                && uri.getRawQuery() == null && uri.getRawFragment() == null && uri.getPort() <= 65535
                && (uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) {
                return "https://" + uri.getRawAuthority();
            }
        } catch (IllegalArgumentException ignored) { }
        throw new IllegalArgumentException("Informe o endereço HTTPS .ts.net que o Tailscale Serve mostrou no PC.");
    }

    private static Snapshot request(String endpoint, String credential, String route, String method, String etag) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) URI.create(endpoint + route).toURL().openConnection();
        try {
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod(method);
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Authorization", "Bearer " + credential);
            conn.setRequestProperty("Accept", "application/json");
            if (etag != null) conn.setRequestProperty("If-None-Match", etag);
            int status = conn.getResponseCode();
            if (status == 304 && etag != null) return new Snapshot(null, etag);
            if (status == 401) throw new Rejected();
            if (status == 403) throw new PrivateNetworkRequired();
            if (status == 404) throw new IOException("Esta conversa não está mais disponível no PC.");
            if (status != 200) throw new IOException("O PC não respondeu à consulta. Confira a conexão privada.");
            try (InputStream input = conn.getInputStream(); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                for (int read; (read = input.read(chunk)) != -1;) {
                    if (data.size() + read > 3 * 1024 * 1024) throw new IOException("A resposta do PC excedeu o limite do celular.");
                    data.write(chunk, 0, read);
                }
                return new Snapshot(new JSONObject(data.toString(StandardCharsets.UTF_8.name())), conn.getHeaderField("ETag"));
            }
        } finally { conn.disconnect(); }
    }

    private static SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.getKey(KEY_ALIAS, null) instanceof SecretKey key) return key;
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
}
