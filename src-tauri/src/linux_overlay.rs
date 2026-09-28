//! The Store laid over the shell, on Linux.
//!
//! On Windows and macOS a child web view is a native layer at the position it
//! is given. On Linux, Tauri packs every web view of a window into the same
//! vertical GtkBox, so the Store was stacked *under* the shell instead of over
//! it: the shell got squashed into the top half of the window and the Store
//! sat below it, ignoring the slot it was meant to fill. Position and size
//! calls are no-ops there, so moving it never helped.
//!
//! Here the two are moved into a GtkOverlay: the shell is its main child and
//! fills the window, the Store is an overlay child placed at exactly the
//! rectangle `store_mount` asks for. Showing and hiding still go through
//! Tauri (they act on the widget itself), so nothing else needs to know.

use std::cell::{Cell, RefCell};

use gtk::prelude::*;

type Rect = (i32, i32, i32, i32);

thread_local! {
    // Main-thread only: every GTK call here runs inside `with_webview`.
    static RECT: Cell<Rect> = const { Cell::new((0, 0, 1, 1)) };
    static OVERLAY: RefCell<Option<gtk::Overlay>> = const { RefCell::new(None) };
}

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    (
        x.round() as i32,
        y.round() as i32,
        width.round().max(1.0) as i32,
        height.round().max(1.0) as i32,
    )
}

/// Put the Store over the shell (first call) or move it (later calls).
/// Coordinates are logical pixels in the main window, as the shell measures
/// them, which is also what GTK allocates in.
pub fn place(view: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) {
    let r = rect(x, y, width, height);
    let _ = view.with_webview(move |w| {
        let store: gtk::Widget = w.inner().upcast();
        RECT.with(|c| c.set(r));
        if OVERLAY.with(|o| o.borrow().is_some()) {
            store.queue_resize();
            return;
        }
        if let Some(overlay) = wrap(&store) {
            OVERLAY.with(|o| *o.borrow_mut() = Some(overlay));
        }
    });
}

fn wrap(store: &gtk::Widget) -> Option<gtk::Overlay> {
    let vbox = store.parent()?.downcast::<gtk::Box>().ok()?;
    // The shell's own web view is the other one in the box.
    let shell = vbox
        .children()
        .into_iter()
        .find(|c| c != store && c.type_().name() == "WebKitWebView")?;
    // Whatever `store_visible` last said, before the move shows everything.
    let store_shown = store.is_visible();

    let overlay = gtk::Overlay::new();
    // The clones above hold both widgets alive across the remove.
    vbox.remove(&shell);
    vbox.remove(store);
    overlay.add(&shell);
    overlay.add_overlay(store);
    overlay.connect_get_child_position(|_, _| {
        let (x, y, w, h) = RECT.with(Cell::get);
        Some(gtk::gdk::Rectangle::new(x, y, w, h))
    });
    vbox.pack_start(&overlay, true, true, 0);
    overlay.show();
    shell.show();
    if store_shown {
        store.show();
    } else {
        store.hide();
    }
    Some(overlay)
}
