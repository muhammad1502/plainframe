package com.muhammad1502.plainframe;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

// Methods the page calls as window.PlainframeAndroid. They run on WebView's background thread.
// Files arrive in base64 pieces (openOutput, writeChunk..., closeOutput) so a long video never
// has to exist as one giant string.
public class Bridge {
    private final MainActivity app;
    private final Map<Integer, Output> outputs = new HashMap<>();
    private final Map<Integer, File> shareFiles = new HashMap<>();
    private int nextId = 1;

    private static class Output {
        OutputStream stream;
        Uri item;       // MediaStore entry, when saving to the gallery or Downloads
        File file;      // cache file, when sharing
    }

    Bridge(MainActivity app) {
        this.app = app;
    }

    // target: "media" (Pictures or Movies), "downloads" or "share". Returns an id, or -1.
    @JavascriptInterface
    public synchronized int openOutput(String target, String name, String mime) {
        try {
            Output o = new Output();
            String safe = new File(name).getName();
            if ("share".equals(target)) {
                File dir = new File(app.getCacheDir(), "share");
                dir.mkdirs();
                o.file = new File(dir, safe);
                o.stream = new FileOutputStream(o.file);
            } else {
                boolean video = mime != null && mime.startsWith("video/");
                Uri collection;
                String folder;
                if ("downloads".equals(target)) {
                    collection = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    folder = "Download";
                } else if (video) {
                    collection = MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    folder = "Movies/Plainframe";
                } else {
                    collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                    folder = "Pictures/Plainframe";
                }
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, safe);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH, folder);
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                o.item = app.getContentResolver().insert(collection, v);
                if (o.item == null) return -1;
                o.stream = app.getContentResolver().openOutputStream(o.item);
                if (o.stream == null) {
                    app.getContentResolver().delete(o.item, null, null);
                    return -1;
                }
            }
            int id = nextId++;
            outputs.put(id, o);
            return id;
        } catch (Exception e) {
            return -1;
        }
    }

    @JavascriptInterface
    public boolean writeChunk(int id, String base64) {
        Output o;
        synchronized (this) { o = outputs.get(id); }
        if (o == null) return false;
        try {
            o.stream.write(Base64.decode(base64, Base64.DEFAULT));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @JavascriptInterface
    public synchronized boolean closeOutput(int id) {
        Output o = outputs.remove(id);
        if (o == null) return false;
        try {
            o.stream.close();
            if (o.item != null) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                app.getContentResolver().update(o.item, done, null, null);
            }
            if (o.file != null) shareFiles.put(id, o.file);
            return true;
        } catch (Exception e) {
            abort(o);
            return false;
        }
    }

    @JavascriptInterface
    public synchronized void abortOutput(int id) {
        Output o = outputs.remove(id);
        if (o != null) abort(o);
    }

    private void abort(Output o) {
        try { o.stream.close(); } catch (Exception ignored) { }
        if (o.item != null) app.getContentResolver().delete(o.item, null, null);
        if (o.file != null) o.file.delete();
    }

    @JavascriptInterface
    public synchronized void clearShareCache() {
        shareFiles.clear();
        File[] old = new File(app.getCacheDir(), "share").listFiles();
        if (old != null) for (File f : old) f.delete();
    }

    // ids: JSON array of closed "share" outputs. Opens the system share sheet.
    @JavascriptInterface
    public synchronized boolean shareOutputs(String json) {
        try {
            JSONArray ids = new JSONArray(json);
            ArrayList<Uri> uris = new ArrayList<>();
            String type = null;
            for (int i = 0; i < ids.length(); i++) {
                File f = shareFiles.get(ids.getInt(i));
                if (f == null) continue;
                uris.add(FileProvider.getUriForFile(app, app.getPackageName() + ".files", f));
                String mime = app.getContentResolver().getType(uris.get(uris.size() - 1));
                if (mime == null) mime = "*/*";
                type = mergeTypes(type, mime);
            }
            if (uris.isEmpty()) return false;
            Intent send = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
            send.setType(type);
            if (uris.size() == 1) send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            else send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            app.runOnUiThread(() -> app.startActivity(Intent.createChooser(send, null)));
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // "image/jpeg" + "image/png" -> "image/*"; an image and a video -> "*/*".
    private static String mergeTypes(String a, String b) {
        if (a == null || a.equals(b)) return b;
        String ta = a.split("/")[0], tb = b.split("/")[0];
        return ta.equals(tb) ? ta + "/*" : "*/*";
    }

    // Files shared into the app from another app, as [{ name, type }]. Each is served at /shared/<index>.
    @JavascriptInterface
    public String sharedFiles() {
        JSONArray out = new JSONArray();
        synchronized (app.shared) {
            for (int i = 0; i < app.shared.size(); i++) {
                Uri u = app.shared.get(i);
                JSONObject o = new JSONObject();
                try {
                    o.put("name", displayName(u, i));
                    String t = app.getContentResolver().getType(u);
                    o.put("type", t == null ? "" : t);
                    out.put(o);
                } catch (Exception ignored) {
                }
            }
        }
        return out.toString();
    }

    @JavascriptInterface
    public void clearShared() {
        synchronized (app.shared) {
            app.shared.clear();
        }
    }

    @JavascriptInterface
    public void setDark(boolean dark) {
        app.setDark(dark);
    }

    private String displayName(Uri u, int i) {
        try (Cursor c = app.getContentResolver().query(u, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getString(0);
        } catch (Exception ignored) {
        }
        return "shared-" + (i + 1);
    }
}
