//! User profile name + share-image export (port of `main/services/profile.ts`,
//! `profile-core.ts`, `profile-share-core.ts`, and `profile-share-files.ts`).
//!
//! - Name resolution: the stored `profileName` setting, or a system display
//!   name from `/usr/bin/id -F` (macOS) with a title-cased account-name
//!   fallback, normalized (NFKC + control chars stripped) and validated
//!   (non-empty, ≤ 80 chars).
//! - Share export: decode + structurally validate a `data:image/png;base64,…`
//!   renderer snapshot (1200×1600, CRC-checked PNG chunks) and write it to a
//!   private 0700 temp directory as `Aiden-usage-profile.png` (0600), plus
//!   stale-directory cleanup.

use std::path::{Path, PathBuf};

/// `MAX_PROFILE_NAME_LENGTH` in profile-core.ts.
pub const MAX_PROFILE_NAME_LENGTH: usize = 80;

/// `PROFILE_SHARE_WIDTH` / `PROFILE_SHARE_HEIGHT` in profile-share-core.ts.
pub const PROFILE_SHARE_WIDTH: u32 = 1200;
pub const PROFILE_SHARE_HEIGHT: u32 = 1600;

/// `MAX_SHARE_IMAGE_BYTES` in profile-share-core.ts.
pub const MAX_SHARE_IMAGE_BYTES: usize = 16 * 1024 * 1024;

/// `PROFILE_SHARE_DIRECTORY_PREFIX` / `PROFILE_SHARE_FILE_NAME` /
/// `PROFILE_SHARE_STALE_AGE_MS` in profile-share-files.ts.
pub const PROFILE_SHARE_DIRECTORY_PREFIX: &str = "aiden-profile-share-";
pub const PROFILE_SHARE_FILE_NAME: &str = "Aiden-usage-profile.png";
pub const PROFILE_SHARE_STALE_AGE_MS: u64 = 24 * 60 * 60 * 1_000;

#[derive(Debug, thiserror::Error)]
pub enum ProfileError {
    #[error("Enter the name you want shown on your profile.")]
    EmptyName,
    #[error("Profile names can be up to {MAX_PROFILE_NAME_LENGTH} characters.")]
    NameTooLong,
    #[error("The profile snapshot must be a PNG image.")]
    NotPng,
    #[error("The profile snapshot is empty or too large.")]
    InvalidSize,
    #[error("The profile snapshot is not valid base64 data.")]
    InvalidBase64,
    #[error("The profile snapshot is not canonical base64 data.")]
    NonCanonicalBase64,
    #[error("The profile snapshot has an invalid PNG signature.")]
    InvalidPngSignature,
    #[error("The profile snapshot has a malformed PNG chunk.")]
    MalformedPngChunk,
    #[error("The profile snapshot has an invalid PNG chunk type.")]
    InvalidPngChunkType,
    #[error("The profile snapshot failed its PNG integrity check.")]
    PngIntegrity,
    #[error("The profile snapshot is missing PNG dimensions.")]
    MissingPngDimensions,
    #[error("The profile snapshot must use Aiden's 3:4 share size.")]
    WrongShareSize,
    #[error("The profile snapshot uses an unsupported PNG format.")]
    UnsupportedPngFormat,
    #[error("The profile snapshot contains duplicate PNG dimensions.")]
    DuplicatePngDimensions,
    #[error("The profile snapshot has an incomplete PNG payload.")]
    IncompletePng,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Settings(String),
}

// ---------------------------------------------------------------------------
// Name normalization / validation (profile-core.ts)
// ---------------------------------------------------------------------------

/// `normalizeProfileName`: NFKC + control characters → spaces + collapse.
pub fn normalize_profile_name(value: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let without_controls: String = value
        .nfkc()
        .flat_map(|character| {
            if character.is_control() {
                ' '.to_string().chars().collect::<Vec<_>>()
            } else {
                vec![character]
            }
        })
        .collect();
    without_controls
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// `validateProfileName`: normalize then enforce presence + length.
pub fn validate_profile_name(value: &str) -> Result<String, ProfileError> {
    let normalized = normalize_profile_name(value);
    if normalized.is_empty() {
        return Err(ProfileError::EmptyName);
    }
    if normalized.chars().count() > MAX_PROFILE_NAME_LENGTH {
        return Err(ProfileError::NameTooLong);
    }
    Ok(normalized)
}

/// `titleCaseUsername` in profile.ts.
fn title_case_username(username: &str) -> String {
    // Insert a space between camelCase boundaries, then split on separators.
    let mut spaced = String::with_capacity(username.len() + 8);
    let mut previous_lower = false;
    for character in username.chars() {
        if character.is_ascii_uppercase() && previous_lower {
            spaced.push(' ');
        }
        spaced.push(character);
        previous_lower = character.is_ascii_lowercase();
    }
    let words: Vec<String> = spaced
        .split(|character: char| {
            character == '.' || character == '_' || character == '-' || character.is_whitespace()
        })
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => {
                    let rest: String = chars.collect();
                    format!("{}{}", first.to_uppercase(), rest.to_lowercase())
                }
                None => String::new(),
            }
        })
        .collect();
    if words.is_empty() {
        "Aiden User".to_string()
    } else {
        words.join(" ")
    }
}

/// The system display name (profile.ts `systemDisplayName`): `/usr/bin/id -F`
/// on macOS with a 1 s timeout, else the title-cased account name.
fn system_display_name() -> String {
    #[cfg(target_os = "macos")]
    {
        let output = std::process::Command::new("/usr/bin/id")
            .arg("-F")
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).into_owned());
        if let Some(output) = output {
            if let Ok(name) = validate_profile_name(&output) {
                let truncated: String = name.chars().take(MAX_PROFILE_NAME_LENGTH).collect();
                return truncated;
            }
        }
    }
    let username = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    title_case_username(&username)
}

/// The settings seam for the profile name (`configStore.getSettings` /
/// `setSettings` in profile.ts).
pub trait ProfileSettings: Send + Sync {
    fn profile_name(&self) -> Result<Option<String>, ProfileError>;
    fn set_profile_name(&self, name: &str) -> Result<(), ProfileError>;
}

/// Profile name resolution + persistence (profile.ts `profileService`).
pub struct ProfileService<S: ProfileSettings> {
    settings: S,
}

impl<S: ProfileSettings> ProfileService<S> {
    pub fn new(settings: S) -> Self {
        Self { settings }
    }

    /// `profileService.get()`: return the stored name, or resolve + persist
    /// the system display name.
    pub fn get(&self) -> Result<String, ProfileError> {
        let existing = normalize_profile_name(&self.settings.profile_name()?.unwrap_or_default());
        if !existing.is_empty() {
            return Ok(existing);
        }
        let name = validate_profile_name(&system_display_name())?;
        self.settings.set_profile_name(&name)?;
        Ok(name)
    }

    /// `profileService.setName(value)`.
    pub fn set_name(&self, value: &str) -> Result<String, ProfileError> {
        let name = validate_profile_name(value)?;
        self.settings.set_profile_name(&name)?;
        Ok(name)
    }
}

/// A `ProfileSettings` adapter over [`crate::config_store::ConfigStore`].
pub struct ConfigStoreProfileSettings<'a> {
    store: &'a crate::config_store::ConfigStore,
}

impl<'a> ConfigStoreProfileSettings<'a> {
    pub fn new(store: &'a crate::config_store::ConfigStore) -> Self {
        Self { store }
    }
}

impl ProfileSettings for ConfigStoreProfileSettings<'_> {
    fn profile_name(&self) -> Result<Option<String>, ProfileError> {
        let settings = self
            .store
            .get_settings()
            .map_err(|error| ProfileError::Settings(error.to_string()))?;
        Ok(settings
            .get("profileName")
            .and_then(|value| value.as_str())
            .map(str::to_string))
    }

    fn set_profile_name(&self, name: &str) -> Result<(), ProfileError> {
        let mut patch = serde_json::Map::new();
        patch.insert(
            "profileName".into(),
            serde_json::Value::String(name.to_string()),
        );
        self.store
            .set_settings(&patch, &|| true)
            .map_err(|error| ProfileError::Settings(error.to_string()))?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Share-image validation (profile-share-core.ts)
// ---------------------------------------------------------------------------

const PNG_DATA_URL_PREFIX: &str = "data:image/png;base64,";
const PNG_SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

fn png_crc32(value: &[u8]) -> u32 {
    let mut crc: u32 = 0xffff_ffff;
    for byte in value {
        crc ^= *byte as u32;
        for _ in 0..8 {
            crc = (crc >> 1) ^ (if crc & 1 != 0 { 0xedb8_8320 } else { 0 });
        }
    }
    crc ^ 0xffff_ffff
}

fn validate_png_structure(image: &[u8]) -> Result<(), ProfileError> {
    let mut offset = PNG_SIGNATURE.len();
    let mut chunk_index = 0usize;
    let mut saw_idat = false;

    while offset + 12 <= image.len() {
        let length = u32::from_be_bytes(image[offset..offset + 4].try_into().unwrap()) as usize;
        let type_start = offset + 4;
        let data_start = type_start + 4;
        let crc_offset = data_start + length;
        let next_offset = crc_offset + 4;
        if length > MAX_SHARE_IMAGE_BYTES || next_offset > image.len() {
            return Err(ProfileError::MalformedPngChunk);
        }
        let chunk_type = &image[type_start..data_start];
        if !chunk_type.iter().all(|byte| byte.is_ascii_alphabetic()) {
            return Err(ProfileError::InvalidPngChunkType);
        }
        let stored_crc = u32::from_be_bytes(image[crc_offset..next_offset].try_into().unwrap());
        if stored_crc != png_crc32(&image[type_start..crc_offset]) {
            return Err(ProfileError::PngIntegrity);
        }

        if chunk_index == 0 {
            if chunk_type != b"IHDR" || length != 13 {
                return Err(ProfileError::MissingPngDimensions);
            }
            let width = u32::from_be_bytes(image[data_start..data_start + 4].try_into().unwrap());
            let height =
                u32::from_be_bytes(image[data_start + 4..data_start + 8].try_into().unwrap());
            if width != PROFILE_SHARE_WIDTH || height != PROFILE_SHARE_HEIGHT {
                return Err(ProfileError::WrongShareSize);
            }
            let bit_depth = image[data_start + 8];
            let color_type = image[data_start + 9];
            let valid_bit_depth = (color_type == 0 && matches!(bit_depth, 1 | 2 | 4 | 8 | 16))
                || (color_type == 2 && matches!(bit_depth, 8 | 16))
                || (color_type == 3 && matches!(bit_depth, 1 | 2 | 4 | 8))
                || ((color_type == 4 || color_type == 6) && matches!(bit_depth, 8 | 16));
            if !valid_bit_depth
                || image[data_start + 10] != 0
                || image[data_start + 11] != 0
                || !matches!(image[data_start + 12], 0 | 1)
            {
                return Err(ProfileError::UnsupportedPngFormat);
            }
        } else if chunk_type == b"IHDR" {
            return Err(ProfileError::DuplicatePngDimensions);
        }

        if chunk_type == b"IDAT" {
            saw_idat = true;
        }
        if chunk_type == b"IEND" {
            if length != 0 || !saw_idat || next_offset != image.len() {
                return Err(ProfileError::IncompletePng);
            }
            return Ok(());
        }

        chunk_index += 1;
        offset = next_offset;
    }
    Err(ProfileError::IncompletePng)
}

/// `decodeProfileSharePng` in profile-share-core.ts: decode + validate a
/// renderer-generated `data:image/png;base64,…` snapshot.
pub fn decode_profile_share_png(data_url: &str) -> Result<Vec<u8>, ProfileError> {
    let Some(encoded) = data_url.strip_prefix(PNG_DATA_URL_PREFIX) else {
        return Err(ProfileError::NotPng);
    };
    if encoded.is_empty() || encoded.len() > MAX_SHARE_IMAGE_BYTES.div_ceil(3) * 4 + 4 {
        return Err(ProfileError::InvalidSize);
    }
    if encoded.len() % 4 != 0
        || !encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(ProfileError::InvalidBase64);
    }
    let decoded = crate::base64::decode(encoded).ok_or(ProfileError::InvalidBase64)?;
    validate_profile_share_png(&decoded)?;
    if crate::base64::encode(&decoded) != encoded {
        return Err(ProfileError::NonCanonicalBase64);
    }
    Ok(decoded)
}

/// Validate an already-decoded renderer-generated share PNG.
///
/// Native surfaces use this before any bytes reach disk or AppKit so callers
/// cannot bypass the same size, integrity, format, and 1200×1600 contract as
/// the Electron data-URL boundary.
pub fn validate_profile_share_png(image: &[u8]) -> Result<(), ProfileError> {
    if image.len() < 24 || image.len() > MAX_SHARE_IMAGE_BYTES {
        return Err(ProfileError::InvalidSize);
    }
    if image.get(..PNG_SIGNATURE.len()) != Some(&PNG_SIGNATURE[..]) {
        return Err(ProfileError::InvalidPngSignature);
    }
    validate_png_structure(image)
}

// ---------------------------------------------------------------------------
// Share file generation (profile-share-files.ts)
// ---------------------------------------------------------------------------

/// `ProfileShareFile` in profile-share-files.ts.
#[derive(Debug, Clone, PartialEq)]
pub struct ProfileShareFile {
    pub directory: PathBuf,
    pub file_path: PathBuf,
}

/// `createProfileShareFile`: a uniquely named, private 0700 temp directory
/// holding the 0600 PNG.
pub fn create_profile_share_file(
    image: &[u8],
    temporary_root: &Path,
) -> Result<ProfileShareFile, ProfileError> {
    let directory = tempfile_directory(temporary_root)?;
    let file_path = directory.join(PROFILE_SHARE_FILE_NAME);
    let result = (|| -> Result<(), ProfileError> {
        set_dir_mode(&directory, 0o700)?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file_path, std::fs::Permissions::from_mode(0o600))?;
        }
        use std::io::Write;
        file.write_all(image)?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_dir_all(&directory);
        return Err(error);
    }
    Ok(ProfileShareFile {
        directory,
        file_path,
    })
}

fn tempfile_directory(temporary_root: &Path) -> Result<PathBuf, ProfileError> {
    for _ in 0..32 {
        let candidate = temporary_root.join(format!(
            "{}{}",
            PROFILE_SHARE_DIRECTORY_PREFIX,
            crate::unique_id()
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::AlreadyExists,
        "could not create a unique profile share directory",
    )
    .into())
}

fn set_dir_mode(directory: &Path, mode: u32) -> Result<(), ProfileError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = mode;
    Ok(())
}

/// `removeProfileShareDirectory`.
pub fn remove_profile_share_directory(directory: &Path) -> Result<(), ProfileError> {
    std::fs::remove_dir_all(directory)?;
    Ok(())
}

/// `cleanupStaleProfileShareDirectories`: remove inactive share dirs older
/// than one day, returning the count removed.
pub fn cleanup_stale_profile_share_directories(
    temporary_root: &Path,
    active_directories: &std::collections::HashSet<PathBuf>,
    now: u64,
) -> Result<u64, ProfileError> {
    let mut removed = 0u64;
    let entries = match std::fs::read_dir(temporary_root) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => return Err(err.into()),
    };
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with(PROFILE_SHARE_DIRECTORY_PREFIX) {
            continue;
        }
        let directory = entry.path();
        if active_directories.contains(&directory) {
            continue;
        }
        let modified = match std::fs::metadata(&directory) {
            Ok(metadata) => metadata
                .modified()
                .map(|time| {
                    time.duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_millis() as u64)
                        .unwrap_or(0)
                })
                .unwrap_or(0),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(err.into()),
        };
        if now.saturating_sub(modified) < PROFILE_SHARE_STALE_AGE_MS {
            continue;
        }
        let _ = std::fs::remove_dir_all(&directory);
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_profile_names_without_retaining_control_characters() {
        // Mirrors profile.test.ts.
        assert_eq!(
            normalize_profile_name("  Sambit\n\tBiswas  "),
            "Sambit Biswas"
        );
        assert_eq!(normalize_profile_name("A\u{0}iden"), "A iden");
        assert_eq!(normalize_profile_name("A\u{85}iden"), "A iden");
    }

    #[test]
    fn validates_profile_name_presence_and_length() {
        assert_eq!(
            validate_profile_name("  Sambit Biswas ").unwrap(),
            "Sambit Biswas"
        );
        assert!(matches!(
            validate_profile_name("\n\t"),
            Err(ProfileError::EmptyName)
        ));
        assert!(matches!(
            validate_profile_name(&"x".repeat(81)),
            Err(ProfileError::NameTooLong)
        ));
    }

    #[test]
    fn title_cases_usernames() {
        assert_eq!(title_case_username("sambit.biswas"), "Sambit Biswas");
        assert_eq!(title_case_username("sambitBiswas"), "Sambit Biswas");
        assert_eq!(
            title_case_username("sambit_biswas-dev"),
            "Sambit Biswas Dev"
        );
        assert_eq!(title_case_username(""), "Aiden User");
    }

    // -- PNG share validation ---------------------------------------------

    struct TestPng;

    impl TestPng {
        fn crc32(value: &[u8]) -> u32 {
            png_crc32(value)
        }

        fn chunk(chunk_type: &[u8; 4], data: &[u8]) -> Vec<u8> {
            let mut result = Vec::with_capacity(12 + data.len());
            result.extend_from_slice(&(data.len() as u32).to_be_bytes());
            result.extend_from_slice(chunk_type);
            result.extend_from_slice(data);
            let mut crc_input = Vec::with_capacity(4 + data.len());
            crc_input.extend_from_slice(chunk_type);
            crc_input.extend_from_slice(data);
            result.extend_from_slice(&Self::crc32(&crc_input).to_be_bytes());
            result
        }

        fn png(width: u32, height: u32) -> Vec<u8> {
            let mut header = vec![0u8; 13];
            header[0..4].copy_from_slice(&width.to_be_bytes());
            header[4..8].copy_from_slice(&height.to_be_bytes());
            header[8] = 1; // bit depth
            header[9] = 0; // color type: grayscale
            let mut image = Vec::new();
            image.extend_from_slice(&PNG_SIGNATURE);
            image.extend_from_slice(&Self::chunk(b"IHDR", &header));
            image.extend_from_slice(&Self::chunk(b"IDAT", &[0x78, 0x9c, 0x01]));
            image.extend_from_slice(&Self::chunk(b"IEND", &[]));
            image
        }

        fn data_url(image: &[u8]) -> String {
            format!("data:image/png;base64,{}", crate::base64::encode(image))
        }
    }

    #[test]
    fn accepts_a_complete_1200_by_1600_png_share_image() {
        let image = TestPng::png(PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT);
        let decoded = decode_profile_share_png(&TestPng::data_url(&image)).unwrap();
        assert_eq!(decoded, image);
    }

    #[test]
    fn rejects_malformed_non_canonical_or_incorrectly_sized_pngs() {
        // Mirrors profile-share-core.test.ts.
        assert!(matches!(
            decode_profile_share_png(&TestPng::data_url(&TestPng::png(1600, 1200))),
            Err(ProfileError::WrongShareSize)
        ));
        assert!(matches!(
            decode_profile_share_png("data:image/jpeg;base64,AAAA"),
            Err(ProfileError::NotPng)
        ));
        assert!(matches!(
            decode_profile_share_png("data:image/png;base64,not base64"),
            Err(ProfileError::InvalidBase64)
        ));

        let mut incomplete = TestPng::png(PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT);
        incomplete.truncate(incomplete.len() - 12);
        assert!(matches!(
            decode_profile_share_png(&TestPng::data_url(&incomplete)),
            Err(ProfileError::IncompletePng)
        ));

        let mut corrupt = TestPng::png(PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT);
        let last = corrupt.len() - 1;
        corrupt[last] ^= 1;
        assert!(matches!(
            decode_profile_share_png(&TestPng::data_url(&corrupt)),
            Err(ProfileError::PngIntegrity)
        ));

        // Trailing garbage after a well-formed PNG must be rejected (the exact
        // error depends on the original padding: non-canonical base64 when the
        // decode re-encodes differently, or an incomplete PNG payload).
        let padded = format!(
            "{}AAAA",
            TestPng::data_url(&TestPng::png(PROFILE_SHARE_WIDTH, PROFILE_SHARE_HEIGHT))
        );
        assert!(decode_profile_share_png(&padded).is_err());
    }

    // -- share files --------------------------------------------------------

    #[test]
    fn creates_a_private_uniquely_named_temporary_png() {
        let root = tempfile::tempdir().unwrap();
        let image = b"private aggregate image";
        let created = create_profile_share_file(image, root.path()).unwrap();
        assert_eq!(
            created.file_path.file_name().unwrap().to_string_lossy(),
            PROFILE_SHARE_FILE_NAME
        );
        assert!(created
            .directory
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(PROFILE_SHARE_DIRECTORY_PREFIX));
        assert_eq!(std::fs::read(&created.file_path).unwrap(), image);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&created.directory)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700
            );
            assert_eq!(
                std::fs::metadata(&created.file_path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn removes_only_stale_inactive_aiden_share_directories() {
        let root = tempfile::tempdir().unwrap();
        let prefix = root.path().join(PROFILE_SHARE_DIRECTORY_PREFIX);
        let stale = create_profile_share_file(b"x", root.path())
            .unwrap()
            .directory;
        let active = create_profile_share_file(b"y", root.path())
            .unwrap()
            .directory;
        let fresh = create_profile_share_file(b"z", root.path())
            .unwrap()
            .directory;
        let unrelated = root.path().join("unrelated-123");
        std::fs::create_dir(&unrelated).unwrap();

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let stale_time = now - PROFILE_SHARE_STALE_AGE_MS - 1_000;
        for directory in [&stale, &active] {
            let _ = filetime::set_file_mtime(
                directory,
                filetime::FileTime::from_unix_time(
                    (stale_time / 1000) as i64,
                    ((stale_time % 1000) * 1_000_000) as u32,
                ),
            );
        }

        let mut active_directories = std::collections::HashSet::new();
        active_directories.insert(active.clone());
        let removed =
            cleanup_stale_profile_share_directories(root.path(), &active_directories, now).unwrap();
        assert_eq!(removed, 1);
        assert!(!stale.exists());
        assert!(active.exists());
        assert!(fresh.exists());
        assert!(unrelated.exists());
        let _ = prefix;
    }
}
