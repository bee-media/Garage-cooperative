package ru.gskrodnik.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Обновление приложения без браузера: скачивает APK внутрь приложения (с прогрессом), проверяет SHA-256
 * и вызывает системный установщик. Файл лежит во внутреннем кэше приложения, другим программам недоступен.
 *
 * Адрес скачивания приходит из приложения (подписанная ссылка на 10 минут). Принимается только HTTPS;
 * HTTP разрешён исключительно в отладочной сборке (для теста во внутренней сети).
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {
    private static final String DIR = "apk";
    private static final String FILE = "update.apk";
    private static final long MAX_BYTES = 200L * 1024 * 1024;

    private volatile boolean downloading = false;

    private boolean isDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private File apkFile() {
        File dir = new File(getContext().getCacheDir(), DIR);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, FILE);
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        final String sha256 = call.getString("sha256");
        if (url == null || sha256 == null || !sha256.matches("(?i)[0-9a-f]{64}")) {
            call.reject("Некорректные параметры загрузки");
            return;
        }
        boolean https = url.startsWith("https://");
        if (!https && !(isDebuggable() && url.startsWith("http://"))) {
            call.reject("Скачивание разрешено только по HTTPS");
            return;
        }
        if (downloading) {
            call.reject("Загрузка уже идёт");
            return;
        }
        downloading = true;
        new Thread(() -> {
            File part = new File(apkFile().getParentFile(), FILE + ".part");
            HttpURLConnection conn = null;
            try {
                //noinspection ResultOfMethodCallIgnored
                apkFile().delete();
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.setInstanceFollowRedirects(false); // ссылка подписана на конкретный адрес, перенаправления не нужны
                int code = conn.getResponseCode();
                if (code != 200) {
                    call.reject(code == 401 || code == 403
                        ? "Ссылка недействительна. Повторите попытку"
                        : "Сервер ответил ошибкой " + code);
                    return;
                }
                long total = conn.getContentLengthLong();
                if (total > MAX_BYTES) {
                    call.reject("Файл слишком большой");
                    return;
                }
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                long loaded = 0, lastEmit = 0;
                byte[] buf = new byte[64 * 1024];
                try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        md.update(buf, 0, n);
                        loaded += n;
                        if (loaded > MAX_BYTES) throw new IllegalStateException("Файл слишком большой");
                        long now = System.currentTimeMillis();
                        if (now - lastEmit > 200) {
                            lastEmit = now;
                            JSObject p = new JSObject();
                            p.put("loaded", loaded);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                StringBuilder hex = new StringBuilder();
                for (byte b : md.digest()) hex.append(String.format(Locale.ROOT, "%02x", b));
                if (!hex.toString().equalsIgnoreCase(sha256)) {
                    //noinspection ResultOfMethodCallIgnored
                    part.delete();
                    call.reject("Файл повреждён при скачивании (не совпала контрольная сумма). Повторите попытку");
                    return;
                }
                if (!part.renameTo(apkFile())) throw new IllegalStateException("Не удалось сохранить файл");
                JSObject done = new JSObject();
                done.put("size", loaded);
                call.resolve(done);
            } catch (Exception e) {
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                call.reject(e.getMessage() != null && e.getMessage().startsWith("Файл")
                    ? e.getMessage() : "Не удалось скачать обновление. Проверьте подключение к сети");
            } finally {
                downloading = false;
                if (conn != null) conn.disconnect();
            }
        }, "apk-download").start();
    }

    private static long versionCode(PackageInfo p) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? p.getLongVersionCode() : p.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signers(PackageInfo p) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return p.signingInfo == null ? null : p.signingInfo.getApkContentsSigners();
        }
        return p.signatures;
    }

    private static Set<String> fingerprints(Signature[] sigs) {
        Set<String> out = new HashSet<>();
        if (sigs != null) for (Signature s : sigs) out.add(Arrays.toString(s.toByteArray()));
        return out;
    }

    /**
     * Проверка скачанного файла ДО установки: это наше приложение (тот же пакет), версия выше установленной и
     * подпись ТЕМ ЖЕ ключом. Так подменённый файл (скомпрометированный сервер, перехваченная ссылка, вредоносный
     * скрипт в WebView) не дойдёт до установщика. Возвращает текст ошибки или null, если всё в порядке.
     */
    @SuppressWarnings("deprecation")
    private String verifyApk(File f) {
        Context ctx = getContext();
        PackageManager pm = ctx.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        try {
            PackageInfo next = pm.getPackageArchiveInfo(f.getAbsolutePath(), flags);
            if (next == null) return "Файл обновления повреждён";
            if (!ctx.getPackageName().equals(next.packageName)) return "Файл не является приложением «ГСК Родник»";
            PackageInfo cur = pm.getPackageInfo(ctx.getPackageName(), flags);
            if (versionCode(next) <= versionCode(cur)) return "Это не более новая версия приложения";
            Set<String> a = fingerprints(signers(next)), b = fingerprints(signers(cur));
            if (a.isEmpty() || !a.equals(b)) return "Файл подписан другим ключом, установка отменена";
            return null;
        } catch (Exception e) {
            return "Не удалось проверить файл обновления";
        }
    }

    /** Запускает установку скачанного файла. Если разрешения нет — открывает системную настройку и сообщает об этом. */
    @PluginMethod
    public void install(PluginCall call) {
        File f = apkFile();
        if (!f.exists() || f.length() == 0) {
            call.reject("Файл обновления не найден. Скачайте его заново");
            return;
        }
        String problem = verifyApk(f);
        if (problem != null) {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            call.reject(problem);
            return;
        }
        Context ctx = getContext();
        JSObject res = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.getPackageManager().canRequestPackageInstalls()) {
                Intent s = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + ctx.getPackageName()));
                s.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(s);
                res.put("needsPermission", true);
                call.resolve(res);
                return;
            }
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            res.put("needsPermission", false);
            call.resolve(res);
        } catch (Exception e) {
            call.reject("Не удалось запустить установку");
        }
    }

    /** Удалить скачанный файл (после успешной установки или отмены) */
    @PluginMethod
    public void cleanup(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), DIR);
        File[] files = dir.listFiles();
        if (files != null) for (File x : files) //noinspection ResultOfMethodCallIgnored
            x.delete();
        call.resolve();
    }
}
