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
import java.io.OutputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.Mac;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import javax.net.ssl.HttpsURLConnection;

final class DesktopConnection {
    private static final String RELAY = "https://bigthree.pmxtecnologia.com/api/companion/v1";
    private static final String KEY_ALIAS = "big-three-desktop-session";
    private static final int IV_LENGTH = 12;
    private static final int B64 = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;
    private static final SecureRandom RANDOM = new SecureRandom();
    private final SharedPreferences prefs;

    record Session(String id, String credential, String key) {}
    record Snapshot(JSONObject data, String etag) {}

    static final class Rejected extends IOException {
        Rejected() { super("Pareamento encerrado ou token inválido. Gere um novo token no PC."); }
    }

    static final class Offline extends IOException {
        Offline() { super("O computador está offline ou ainda não respondeu. Abra o Big Three no PC."); }
    }

    DesktopConnection(Context context) {
        prefs = context.getSharedPreferences("desktop-connection", Context.MODE_PRIVATE);
    }

    Session pair(String code) throws Exception {
        if (!valid(code)) throw new IllegalArgumentException("Cole o token de pareamento gerado na versão atual do PC.");
        byte[] seed = Base64.decode(code, B64);
        String id = derive(seed, "id");
        String claim = derive(seed, "claim");
        Session session = new Session(id, Base64.encodeToString(random(32), B64), derive(seed, "key"));
        String verifier = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(utf8(session.credential())), B64);
        JSONObject reply = request("/sessions/" + id + "/claim", claim, new JSONObject().put("verifier", verifier));
        if (!reply.optBoolean("paired")) throw new IOException("Pareamento não confirmado.");

        JSONObject stored = new JSONObject().put("id", id).put("credential", session.credential()).put("key", session.key());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] packet = append(cipher.getIV(), cipher.doFinal(utf8(stored.toString())));
        prefs.edit().remove("endpoint").putString("session", Base64.encodeToString(packet, B64)).apply();
        return session;
    }

    Session restore() throws Exception {
        String saved = prefs.getString("session", null);
        if (saved == null) return null;
        byte[] packet = Base64.decode(saved, B64);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, packet, 0, IV_LENGTH));
        JSONObject json = new JSONObject(new String(cipher.doFinal(packet, IV_LENGTH, packet.length - IV_LENGTH), StandardCharsets.UTF_8));
        Session session = new Session(json.getString("id"), json.getString("credential"), json.getString("key"));
        if (!valid(session.id()) || !valid(session.credential()) || !valid(session.key())) throw new Rejected();
        return session;
    }

    void forget() { prefs.edit().remove("session").remove("endpoint").apply(); }

    Snapshot read(Session session, String conversation, String etag) throws Exception {
        String exchange = UUID.randomUUID().toString();
        JSONObject input = new JSONObject();
        if (conversation != null) input.put("conversationId", conversation);
        if (etag != null) input.put("etag", etag);
        byte[] nonce = random(IV_LENGTH);
        Cipher encrypt = cipher(session.key(), exchange, "read", nonce, Cipher.ENCRYPT_MODE);
        String payload = Base64.encodeToString(append(nonce, encrypt.doFinal(utf8(input.toString()))), B64);
        JSONObject reply = request("/sessions/" + session.id() + "/read", session.credential(), new JSONObject().put("exchange", exchange).put("payload", payload));
        byte[] response = Base64.decode(reply.getString("payload"), B64);
        if (response.length < 28) throw new IOException("Resposta inválida do computador.");
        Cipher decrypt = cipher(session.key(), exchange, "reply", Arrays.copyOf(response, IV_LENGTH), Cipher.DECRYPT_MODE);
        JSONObject data = new JSONObject(new String(decrypt.doFinal(response, IV_LENGTH, response.length - IV_LENGTH), StandardCharsets.UTF_8));
        if (data.optInt("status") == 304 && etag != null) return new Snapshot(null, etag);
        if (data.optInt("status") == 404) throw new IllegalArgumentException("Esta conversa não está mais disponível no PC.");
        if (data.optInt("status") != 200) throw new IOException("Não foi possível consultar o computador.");
        return new Snapshot(data.getJSONObject("data"), data.getString("etag"));
    }

    private static JSONObject request(String route, String credential, JSONObject json) throws Exception {
        HttpsURLConnection conn = (HttpsURLConnection) URI.create(RELAY + route).toURL().openConnection();
        try {
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(6000);
            conn.setReadTimeout(14_000);
            conn.setRequestProperty("Authorization", "Bearer " + credential);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setDoOutput(true);
            byte[] content = utf8(json.toString());
            conn.setFixedLengthStreamingMode(content.length);
            try (OutputStream out = conn.getOutputStream()) { out.write(content); }
            int status = conn.getResponseCode();
            if (status == 401) throw new Rejected();
            if (status == 503) throw new Offline();
            if (status != 200) throw new IOException("O servidor não respondeu à consulta.");
            try (InputStream input = conn.getInputStream(); ByteArrayOutputStream data = new ByteArrayOutputStream()) {
                byte[] chunk = new byte[4096];
                for (int read; (read = input.read(chunk)) != -1;) {
                    if (data.size() + read > 3 * 1024 * 1024) throw new IOException("A resposta excedeu o limite do celular.");
                    data.write(chunk, 0, read);
                }
                return new JSONObject(data.toString(StandardCharsets.UTF_8.name()));
            }
        } finally { conn.disconnect(); }
    }

    private static String derive(byte[] seed, String label) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(seed, "HmacSHA256"));
        return Base64.encodeToString(mac.doFinal(utf8("big-three/v1/" + label)), B64);
    }

    private static Cipher cipher(String key, String exchange, String direction, byte[] nonce, int mode) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(Base64.decode(key, B64), "AES"), new GCMParameterSpec(128, nonce));
        cipher.updateAAD(utf8("big-three/v1/" + direction + "/" + exchange));
        return cipher;
    }

    private static boolean valid(String value) { return value.matches("[A-Za-z0-9_-]{43}"); }
    private static byte[] utf8(String value) { return value.getBytes(StandardCharsets.UTF_8); }
    private static byte[] random(int size) { byte[] value = new byte[size]; RANDOM.nextBytes(value); return value; }
    private static byte[] append(byte[] left, byte[] right) {
        byte[] joined = Arrays.copyOf(left, left.length + right.length);
        System.arraycopy(right, 0, joined, left.length, right.length);
        return joined;
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
