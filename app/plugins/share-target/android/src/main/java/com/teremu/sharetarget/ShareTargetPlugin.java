package com.teremu.sharetarget;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Log;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.json.JSONArray;

/**
 * Share-sheet target (docs/share-target.md). A shared photo / PDF is
 * copied into an on-disk inbox (cache/shared-inbox) and the web app
 * PULLS it with getPending() — so a share that cold-starts the app is
 * never lost to a listener that isn't registered yet, and a WebView
 * reload before the scan is submitted finds the files still there.
 * The web app deletes them with clear() once the scanner took them.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static final String TAG = "ShareTarget";
    private static final String INBOX = "shared-inbox";
    private static final String PARTIAL = ".part";

    @Override
    public void load() {
        consume(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        consume(intent);
    }

    /** Copies the intent's files into the inbox off the main thread, then nudges the web app. */
    private void consume(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        // Reopening the app from Recents re-delivers the original share intent.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        final List<Uri> uris = streams(intent, action);
        // Handled once: a later getIntent() (activity recreation) must not re-import it.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        if (uris.isEmpty()) return;

        new Thread(() -> {
            long stamp = System.currentTimeMillis();
            int copied = 0;
            for (int i = 0; i < uris.size(); i++) {
                if (copy(uris.get(i), stamp + "-" + i + "-")) copied++;
            }
            // Retained so a listener that attaches later still hears it.
            if (copied > 0) notifyListeners("shareReceived", new JSObject(), true);
        }).start();
    }

    @SuppressWarnings("deprecation")
    private List<Uri> streams(Intent intent, String action) {
        List<Uri> out = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (uri != null) out.add(uri);
        } else {
            ArrayList<Uri> list = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (list != null) out.addAll(list);
        }
        return out;
    }

    private boolean copy(Uri uri, String prefix) {
        ContentResolver resolver = getContext().getContentResolver();
        String mime = resolver.getType(uri);
        String name = displayName(uri);
        if (mime == null) mime = mimeFromName(name);
        // The intent filter already limits this, but a sender may lie about the type.
        if (mime == null || !(mime.startsWith("image/") || mime.equals("application/pdf"))) return false;
        if (name == null || name.isEmpty()) name = "shared";
        name = name.replaceAll("[^A-Za-z0-9._-]", "_");
        String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
        if (ext != null && !name.toLowerCase().endsWith("." + ext) && mimeFromName(name) == null) name = name + "." + ext;

        File dir = inbox();
        File partial = new File(dir, prefix + name + PARTIAL);
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(partial)) {
            if (in == null) return false;
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
        } catch (Exception e) {
            Log.e(TAG, "Could not copy shared file " + uri, e);
            partial.delete();
            return false;
        }
        // Renamed only once complete — getPending() never sees half a file.
        return partial.renameTo(new File(dir, prefix + name));
    }

    private String displayName(Uri uri) {
        if ("file".equals(uri.getScheme())) return new File(uri.getPath()).getName();
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index != -1) return cursor.getString(index);
            }
        } catch (Exception e) {
            Log.w(TAG, "No display name for " + uri, e);
        }
        return null;
    }

    private static String mimeFromName(String name) {
        if (name == null) return null;
        int dot = name.lastIndexOf('.');
        if (dot < 0) return null;
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substring(dot + 1).toLowerCase());
    }

    private File inbox() {
        File dir = new File(getContext().getCacheDir(), INBOX);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** Files waiting in the inbox, oldest share first: [{ path, name, mimeType }]. */
    @PluginMethod
    public void getPending(PluginCall call) {
        File[] files = inbox().listFiles();
        JSArray out = new JSArray();
        if (files != null) {
            Arrays.sort(files, (a, b) -> a.getName().compareTo(b.getName()));
            for (File f : files) {
                if (!f.isFile() || f.getName().endsWith(PARTIAL)) continue;
                // Strip the "<stamp>-<index>-" prefix back to the sender's file name.
                String name = f.getName().replaceFirst("^\\d+-\\d+-", "");
                String mime = mimeFromName(name);
                JSObject item = new JSObject();
                item.put("path", f.getAbsolutePath());
                item.put("name", name);
                item.put("mimeType", mime != null ? mime : "application/octet-stream");
                out.put(item);
            }
        }
        JSObject ret = new JSObject();
        ret.put("files", out);
        call.resolve(ret);
    }

    /** Deletes the given inbox files (only inbox files — never an arbitrary path). */
    @PluginMethod
    public void clear(PluginCall call) {
        JSArray paths = call.getArray("paths", new JSArray());
        try {
            String root = inbox().getCanonicalPath() + File.separator;
            JSONArray list = paths;
            for (int i = 0; i < list.length(); i++) {
                File f = new File(list.getString(i));
                if (f.getCanonicalPath().startsWith(root)) f.delete();
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not clear shared files", e);
        }
    }
}
