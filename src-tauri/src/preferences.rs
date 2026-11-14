use serde_json::Value;
use std::{collections::HashMap, error::Error, fs, io, path::Path};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

fn read_preferences(path: &Path) -> Result<HashMap<String, Value>, Box<dyn Error>> {
    match fs::read(path) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(HashMap::new()),
        Err(error) => Err(error.into()),
    }
}

pub fn initialize(app: &AppHandle) -> Result<(), Box<dyn Error>> {
    let path = app.path().app_data_dir()?.join("settings.json");
    // StoreBuilder normally ignores read/parse errors. Read explicitly so an
    // unreadable file is never replaced with defaults on the next save or exit.
    let values = read_preferences(&path)?;
    app.store_builder(path)
        .defaults(values)
        .create_new()
        .disable_auto_save()
        .build()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::read_preferences;
    use std::fs;

    #[test]
    fn reads_existing_preferences_and_allows_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        assert!(read_preferences(&path).unwrap().is_empty());
        fs::write(&path, r#"{"diffinch.theme":"dark","future":{"value":1}}"#).unwrap();
        let preferences = read_preferences(&path).unwrap();
        assert_eq!(preferences["diffinch.theme"], "dark");
        assert_eq!(preferences["future"]["value"], 1);
    }

    #[test]
    fn rejects_invalid_or_unreadable_files_without_changing_them() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        for contents in ["{broken", "[]", "null"] {
            fs::write(&path, contents).unwrap();
            assert!(read_preferences(&path).is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), contents);
        }
        assert!(read_preferences(dir.path()).is_err());
    }
}
