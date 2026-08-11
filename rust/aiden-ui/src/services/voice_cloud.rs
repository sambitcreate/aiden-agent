//! Fixed-origin cloud transcription transport for explicit Voice recordings.
//!
//! Audio and credentials are process-only request values. This module never
//! writes either to disk and never includes provider response bodies or
//! transport diagnostics in its public errors.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use futures::future::BoxFuture;
use futures::{FutureExt as _, StreamExt as _};
use sha2::Digest as _;

const OPENAI_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const GEMINI_ORIGIN: &str = "https://generativelanguage.googleapis.com";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CloudVoiceProvider {
    OpenAi,
    Gemini,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CloudUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub reasoning: u64,
    pub total: u64,
}

pub(crate) struct CloudVoiceRequest {
    pub provider: CloudVoiceProvider,
    pub model: String,
    pub api_key: String,
    pub wav: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct CloudVoiceResult {
    pub transcript: String,
    pub usage: Option<CloudUsage>,
}

#[derive(Debug, Clone, Copy, thiserror::Error, PartialEq, Eq)]
pub(crate) enum CloudVoiceError {
    #[error("The recording is too large for cloud transcription.")]
    RequestTooLarge,
    #[error("The transcription service could not be reached.")]
    Unavailable,
    #[error("The transcription service rejected the recording.")]
    Rejected,
    #[error("The transcription service returned an invalid response.")]
    InvalidResponse,
    #[error("Cloud transcription timed out.")]
    TimedOut,
}

pub(crate) trait CloudVoiceTranscriber: Send + Sync {
    fn transcribe(
        &self,
        request: CloudVoiceRequest,
    ) -> BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>>;
}

#[derive(Clone)]
struct HttpRequest {
    url: String,
    authorization: Option<String>,
    google_api_key: Option<String>,
    content_type: String,
    body: Vec<u8>,
}

struct HttpResponse {
    status: u16,
    body: Vec<u8>,
}

trait VoiceHttp: Send + Sync {
    fn post(
        &self,
        request: HttpRequest,
    ) -> BoxFuture<'static, Result<HttpResponse, CloudVoiceError>>;
}

type ResponseParser = fn(&[u8]) -> Result<CloudVoiceResult, CloudVoiceError>;

#[derive(Debug, Clone, Copy)]
struct PublicOnlyDnsResolver;

impl reqwest::dns::Resolve for PublicOnlyDnsResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addresses = tokio::net::lookup_host((host.as_str(), 0))
                .await
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error + Send + Sync>)?
                .collect::<Vec<_>>();
            if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
                return Err(Box::new(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "voice provider host is not public",
                ))
                    as Box<dyn std::error::Error + Send + Sync>);
            }
            Ok(Box::new(addresses.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let octets = address.octets();
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || address.is_multicast()
                || address.is_broadcast()
                || octets[0] == 0
                || (octets[0] == 100 && (64..=127).contains(&octets[1]))
                || (octets[0] == 192 && octets[1] == 0 && octets[2] == 0)
                || (octets[0] == 198 && matches!(octets[1], 18 | 19))
                || matches!(
                    octets,
                    [192, 0, 2, _] | [198, 51, 100, _] | [203, 0, 113, _]
                )
                || octets[0] >= 224)
        }
        IpAddr::V6(address) => {
            let segments = address.segments();
            !(address.is_unspecified()
                || address.is_loopback()
                || address.is_multicast()
                || (segments[0] & 0xfe00) == 0xfc00
                || (segments[0] & 0xffc0) == 0xfe80
                || (segments[0] == 0x2001 && segments[1] == 0x0db8))
        }
    }
}

struct ProductionVoiceHttp {
    client: Option<reqwest::Client>,
}

impl ProductionVoiceHttp {
    fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .dns_resolver(Arc::new(PublicOnlyDnsResolver))
            .build()
            .ok();
        Self { client }
    }
}

impl VoiceHttp for ProductionVoiceHttp {
    fn post(
        &self,
        request: HttpRequest,
    ) -> BoxFuture<'static, Result<HttpResponse, CloudVoiceError>> {
        let client = self.client.clone();
        async move {
            if request.body.len() > MAX_REQUEST_BYTES {
                return Err(CloudVoiceError::RequestTooLarge);
            }
            let client = client.ok_or(CloudVoiceError::Unavailable)?;
            let mut builder = client
                .post(request.url)
                .header(reqwest::header::CONTENT_TYPE, request.content_type)
                .body(request.body);
            if let Some(value) = request.authorization {
                let mut value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| CloudVoiceError::Rejected)?;
                value.set_sensitive(true);
                builder = builder.header(reqwest::header::AUTHORIZATION, value);
            }
            if let Some(value) = request.google_api_key {
                let mut value = reqwest::header::HeaderValue::from_str(&value)
                    .map_err(|_| CloudVoiceError::Rejected)?;
                value.set_sensitive(true);
                builder = builder.header("x-goog-api-key", value);
            }
            let response = tokio::time::timeout(TRANSCRIPTION_TIMEOUT, builder.send())
                .await
                .map_err(|_| CloudVoiceError::TimedOut)?
                .map_err(|_| CloudVoiceError::Unavailable)?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| CloudVoiceError::InvalidResponse)?;
                if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                    return Err(CloudVoiceError::InvalidResponse);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpResponse { status, body })
        }
        .boxed()
    }
}

pub(crate) struct ProductionCloudVoiceTranscriber {
    http: Arc<dyn VoiceHttp>,
}

impl ProductionCloudVoiceTranscriber {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            http: Arc::new(ProductionVoiceHttp::new()),
        })
    }

    #[cfg(test)]
    fn with_http(http: Arc<dyn VoiceHttp>) -> Arc<Self> {
        Arc::new(Self { http })
    }
}

impl CloudVoiceTranscriber for ProductionCloudVoiceTranscriber {
    fn transcribe(
        &self,
        request: CloudVoiceRequest,
    ) -> BoxFuture<'static, Result<CloudVoiceResult, CloudVoiceError>> {
        let http = self.http.clone();
        async move {
            let (http_request, parser): (HttpRequest, ResponseParser) = match request.provider {
                CloudVoiceProvider::OpenAi => {
                    let (content_type, body) = openai_multipart(&request.model, &request.wav)?;
                    (
                        HttpRequest {
                            url: OPENAI_URL.to_string(),
                            authorization: Some(format!("Bearer {}", request.api_key)),
                            google_api_key: None,
                            content_type,
                            body,
                        },
                        parse_openai,
                    )
                }
                CloudVoiceProvider::Gemini => {
                    let url = format!(
                        "{GEMINI_ORIGIN}/v1beta/models/{}:generateContent",
                        request.model
                    );
                    let body = gemini_body(&request.wav)?;
                    (
                        HttpRequest {
                            url,
                            authorization: None,
                            google_api_key: Some(request.api_key),
                            content_type: "application/json".to_string(),
                            body,
                        },
                        parse_gemini,
                    )
                }
            };
            let response = http.post(http_request).await?;
            if !(200..300).contains(&response.status) {
                return Err(CloudVoiceError::Rejected);
            }
            parser(&response.body)
        }
        .boxed()
    }
}

fn openai_multipart(model: &str, wav: &[u8]) -> Result<(String, Vec<u8>), CloudVoiceError> {
    let digest = sha2::Sha256::digest(wav);
    let mut boundary = format!("aiden-voice-{}", hex_prefix(&digest));
    while wav
        .windows(boundary.len())
        .any(|window| window == boundary.as_bytes())
    {
        boundary.push('x');
    }
    let prefix = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\n{model}\r\n\
         --{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\n\
         Content-Type: audio/wav\r\n\r\n"
    );
    let suffix = format!("\r\n--{boundary}--\r\n");
    let length = prefix
        .len()
        .saturating_add(wav.len())
        .saturating_add(suffix.len());
    if length > MAX_REQUEST_BYTES {
        return Err(CloudVoiceError::RequestTooLarge);
    }
    let mut body = Vec::with_capacity(length);
    body.extend_from_slice(prefix.as_bytes());
    body.extend_from_slice(wav);
    body.extend_from_slice(suffix.as_bytes());
    Ok((format!("multipart/form-data; boundary={boundary}"), body))
}

fn hex_prefix(bytes: &[u8]) -> String {
    bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn gemini_body(wav: &[u8]) -> Result<Vec<u8>, CloudVoiceError> {
    let encoded_len = wav
        .len()
        .checked_add(2)
        .and_then(|length| length.checked_div(3))
        .and_then(|length| length.checked_mul(4))
        .ok_or(CloudVoiceError::RequestTooLarge)?;
    if encoded_len.saturating_add(1_024) > MAX_REQUEST_BYTES {
        return Err(CloudVoiceError::RequestTooLarge);
    }
    let encoded = base64::engine::general_purpose::STANDARD.encode(wav);
    let body = serde_json::to_vec(&serde_json::json!({
        "contents": [{
            "parts": [
                {"text": "Transcribe the following audio verbatim. Output only the transcript text, nothing else."},
                {"inline_data": {"mime_type": "audio/wav", "data": encoded}}
            ]
        }]
    }))
    .map_err(|_| CloudVoiceError::InvalidResponse)?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err(CloudVoiceError::RequestTooLarge);
    }
    Ok(body)
}

fn parse_openai(body: &[u8]) -> Result<CloudVoiceResult, CloudVoiceError> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| CloudVoiceError::InvalidResponse)?;
    let object = value.as_object().ok_or(CloudVoiceError::InvalidResponse)?;
    let transcript = bounded_transcript(object.get("text"))?;
    let usage = object.get("usage").and_then(parse_openai_usage);
    Ok(CloudVoiceResult { transcript, usage })
}

fn parse_gemini(body: &[u8]) -> Result<CloudVoiceResult, CloudVoiceError> {
    let value: serde_json::Value =
        serde_json::from_slice(body).map_err(|_| CloudVoiceError::InvalidResponse)?;
    let object = value.as_object().ok_or(CloudVoiceError::InvalidResponse)?;
    let parts = object
        .get("candidates")
        .and_then(serde_json::Value::as_array)
        .and_then(|candidates| candidates.first())
        .and_then(|candidate| candidate.get("content"))
        .and_then(|content| content.get("parts"))
        .and_then(serde_json::Value::as_array)
        .ok_or(CloudVoiceError::InvalidResponse)?;
    let mut joined = String::new();
    for text in parts
        .iter()
        .filter_map(|part| part.get("text"))
        .filter_map(serde_json::Value::as_str)
    {
        if !joined.is_empty() {
            joined.push(' ');
        }
        joined.push_str(text);
        if joined.len() > 100_000 {
            return Err(CloudVoiceError::InvalidResponse);
        }
    }
    let transcript = bounded_transcript(Some(&serde_json::Value::String(joined)))?;
    let usage = object.get("usageMetadata").and_then(parse_gemini_usage);
    Ok(CloudVoiceResult { transcript, usage })
}

fn bounded_transcript(value: Option<&serde_json::Value>) -> Result<String, CloudVoiceError> {
    let transcript = value
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .ok_or(CloudVoiceError::InvalidResponse)?;
    if transcript.len() > 100_000 || transcript.contains('\0') {
        return Err(CloudVoiceError::InvalidResponse);
    }
    Ok(transcript.to_string())
}

fn parse_openai_usage(value: &serde_json::Value) -> Option<CloudUsage> {
    let object = value.as_object()?;
    let input = bounded_u64(object.get("input_tokens"))?;
    let output = bounded_u64(object.get("output_tokens")).unwrap_or(0);
    let total = bounded_u64(object.get("total_tokens")).unwrap_or(input.saturating_add(output));
    Some(CloudUsage {
        input,
        output,
        total,
        ..CloudUsage::default()
    })
}

fn parse_gemini_usage(value: &serde_json::Value) -> Option<CloudUsage> {
    let object = value.as_object()?;
    let input = bounded_u64(object.get("promptTokenCount"))?;
    let output = bounded_u64(object.get("candidatesTokenCount")).unwrap_or(0);
    let cache_read = bounded_u64(object.get("cachedContentTokenCount")).unwrap_or(0);
    let reasoning = bounded_u64(object.get("thoughtsTokenCount")).unwrap_or(0);
    let total = bounded_u64(object.get("totalTokenCount"))
        .unwrap_or(input.saturating_add(output).saturating_add(reasoning));
    Some(CloudUsage {
        input,
        output,
        cache_read,
        reasoning,
        total,
    })
}

fn bounded_u64(value: Option<&serde_json::Value>) -> Option<u64> {
    value?.as_u64().filter(|value| *value <= 1_000_000_000)
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};
    use std::sync::Mutex;

    use super::*;

    struct RecordingHttp {
        requests: Arc<Mutex<Vec<HttpRequest>>>,
        response: Mutex<Option<Result<HttpResponse, CloudVoiceError>>>,
    }

    impl VoiceHttp for RecordingHttp {
        fn post(
            &self,
            request: HttpRequest,
        ) -> BoxFuture<'static, Result<HttpResponse, CloudVoiceError>> {
            self.requests.lock().unwrap().push(request);
            let result = self.response.lock().unwrap().take().unwrap();
            async move { result }.boxed()
        }
    }

    #[tokio::test]
    async fn openai_uses_the_fixed_origin_bearer_and_bounded_wav_multipart() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(RecordingHttp {
            requests: requests.clone(),
            response: Mutex::new(Some(Ok(HttpResponse {
                status: 200,
                body: br#"{"text":" hello ","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}"#.to_vec(),
            }))),
        });
        let client = ProductionCloudVoiceTranscriber::with_http(http);
        let result = client
            .transcribe(CloudVoiceRequest {
                provider: CloudVoiceProvider::OpenAi,
                model: "gpt-4o-mini-transcribe".into(),
                api_key: "openai-secret".into(),
                wav: b"RIFF-safe-audio".to_vec(),
            })
            .await
            .unwrap();
        assert_eq!(result.transcript, "hello");
        assert_eq!(result.usage.unwrap().total, 6);
        let requests = requests.lock().unwrap();
        let request = &requests[0];
        assert_eq!(request.url, OPENAI_URL);
        assert_eq!(
            request.authorization.as_deref(),
            Some("Bearer openai-secret")
        );
        assert!(request.google_api_key.is_none());
        assert!(request
            .content_type
            .starts_with("multipart/form-data; boundary="));
        assert!(request
            .body
            .windows(15)
            .any(|part| part == b"RIFF-safe-audio"));
    }

    #[tokio::test]
    async fn gemini_uses_a_header_not_a_query_and_parses_all_text_parts() {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let http = Arc::new(RecordingHttp {
            requests: requests.clone(),
            response: Mutex::new(Some(Ok(HttpResponse {
                status: 200,
                body: br#"{"candidates":[{"content":{"parts":[{"text":"hello"},{"text":"world"}]}}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":2,"totalTokenCount":10}}"#.to_vec(),
            }))),
        });
        let client = ProductionCloudVoiceTranscriber::with_http(http);
        let result = client
            .transcribe(CloudVoiceRequest {
                provider: CloudVoiceProvider::Gemini,
                model: "gemini-2.5-flash".into(),
                api_key: "google-secret".into(),
                wav: b"wav".to_vec(),
            })
            .await
            .unwrap();
        assert_eq!(result.transcript, "hello world");
        let requests = requests.lock().unwrap();
        let request = &requests[0];
        assert_eq!(
            request.url,
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
        );
        assert!(!request.url.contains("google-secret"));
        assert_eq!(request.google_api_key.as_deref(), Some("google-secret"));
        assert!(request.authorization.is_none());
    }

    #[tokio::test]
    async fn provider_failures_are_fixed_and_never_echo_secrets_or_bodies() {
        let http = Arc::new(RecordingHttp {
            requests: Arc::new(Mutex::new(Vec::new())),
            response: Mutex::new(Some(Ok(HttpResponse {
                status: 302,
                body: b"openai-secret provider-private-body".to_vec(),
            }))),
        });
        let error = ProductionCloudVoiceTranscriber::with_http(http)
            .transcribe(CloudVoiceRequest {
                provider: CloudVoiceProvider::OpenAi,
                model: "whisper-1".into(),
                api_key: "openai-secret".into(),
                wav: b"wav".to_vec(),
            })
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(error, "The transcription service rejected the recording.");
        assert!(!error.contains("secret") && !error.contains("private"));
    }

    #[test]
    fn public_dns_policy_rejects_private_loopback_link_local_and_documentation_ranges() {
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(!is_public_ip(IpAddr::V4(Ipv4Addr::new(192, 0, 2, 1))));
        assert!(!is_public_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        assert!(is_public_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn parsing_and_request_caps_are_fail_closed() {
        assert_eq!(parse_openai(br#"{"text":""}"#).unwrap().transcript, "");
        assert_eq!(
            parse_gemini(br#"{"candidates":[]}"#).unwrap_err(),
            CloudVoiceError::InvalidResponse
        );
        assert_eq!(
            gemini_body(&vec![0; MAX_REQUEST_BYTES]).unwrap_err(),
            CloudVoiceError::RequestTooLarge
        );
    }
}
