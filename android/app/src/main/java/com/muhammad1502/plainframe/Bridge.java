package com.muhammad1502.plainframe;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.database.Cursor;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.ArrayList;

// Methods the page calls as window.PlainframeAndroid. They run on WebView's background thread.
public class Bridge {
    private final MainActivity app;

    Bridge(MainActivity app) {
        this.app = app;
    }

    @JavascriptInterface
    public boolean saveToGallery(String name, String mime, String base64) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/Plainframe");
        return insert(MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v, base64);
    }

    @JavascriptInterface
    public boolean saveToDownloads(String name, String mime, String base64) {
        ContentValues v = new ContentValues();
        v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        v.put(MediaStore.MediaColumns.RELATIVE_PATH, "Download");
        return insert(MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY), v, base64);
    }

    private boolean insert(Uri collection, ContentValues v, String base64) {
        ContentResolver cr = app.getContentResolver();
        v.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = null;
        try {
            item = cr.insert(collection, v);
            if (item == null) return false;
            try (OutputStream out = cr.openOutputStream(item)) {
                out.write(Base64.decode(base64, Base64.DEFAULT));
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(item, done, null, null);
            return true;
        } catch (Exception e) {
            if (item != null) cr.delete(item, null, null);
            return false;
        }
    }

    // files: [{ name, mime, data }] with base64 data. Opens the system share sheet.
    @JavascriptInterface
    public boolean share(String json) {
        try {
            File dir = new File(app.getCacheDir(), "share");
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete();
            dir.mkdirs();
            JSONArray list = new JSONArray(json);
            ArrayList<Uri> uris = new ArrayList<>();
            String type = null;
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.getJSONObject(i);
                File f = new File(dir, new File(o.getString("name")).getName());
                try (FileOutputStream out = new FileOutputStream(f)) {
                    out.write(Base64.decode(o.getString("data"), Base64.DEFAULT));
                }
                uris.add(FileProvider.getUriForFile(app, app.getPackageName() + ".files", f));
                String mime = o.getString("mime");
                type = type == null || type.equals(mime) ? mime : "image/*";
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

    // Photos shared into the app from another app, as [{ name, type }]. Each is served at shared/<index>.
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
