fn main() {
    tauri_build::build();
    // Tauri links Windows resources into normal binaries only. The standalone
    // dev example also needs the Common Controls v6 manifest to start correctly.
    #[cfg(windows)]
    println!(
        "cargo:rustc-link-arg-examples={}\\resource.lib",
        std::env::var("OUT_DIR").unwrap()
    );
}
