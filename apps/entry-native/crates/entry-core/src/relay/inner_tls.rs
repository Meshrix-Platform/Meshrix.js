//! Pinned inner TLS 1.3 client — port of `createInnerTlsClient`.
//!
//! The inner channel is authenticated by the peer *SPKI pin*, never by CA
//! trust and never by a relay-selected identifier. The entry presents its
//! device certificate; the endpoint presents a certificate whose
//! SubjectPublicKeyInfo must hash into the pinned set.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, Error as RustlsError, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::b64::b64u_encode;
use crate::error::{entry_error, Result};

/// sha256(cert subjectPublicKeyInfo DER) as base64url — the endpoint pin.
pub fn spki_pin_from_cert_der(cert_der: &[u8]) -> Option<String> {
    let (_, cert) = x509_parser::parse_x509_certificate(cert_der).ok()?;
    let spki_der: &[u8] = cert.public_key().raw;
    Some(b64u_encode(&Sha256::digest(spki_der)))
}

#[derive(Debug)]
pub struct PinVerifier {
    pinned: HashSet<String>,
    provider: Arc<CryptoProvider>,
    /// Set once a peer certificate passed the pin — observable by callers.
    verified_pin: Arc<Mutex<Option<String>>>,
}

impl PinVerifier {
    pub fn new(pinned: HashSet<String>, provider: Arc<CryptoProvider>) -> Self {
        Self { pinned, provider, verified_pin: Arc::new(Mutex::new(None)) }
    }

    pub fn verified_pin(&self) -> Arc<Mutex<Option<String>>> {
        self.verified_pin.clone()
    }
}

impl ServerCertVerifier for PinVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, RustlsError> {
        let pin = spki_pin_from_cert_der(end_entity.as_ref()).ok_or_else(|| {
            RustlsError::General("unparsable peer certificate".into())
        })?;
        if !self.pinned.contains(&pin) {
            return Err(RustlsError::General(
                "inner_tls_peer_unpinned: peer identity is not pinned for this endpoint".into(),
            ));
        }
        *self.verified_pin.lock().unwrap() = Some(pin);
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        Err(RustlsError::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        false
    }
}

/// Build a TLS 1.3-only client connector with the entry device certificate
/// and endpoint SPKI pinning. `client_key` is the PKCS#8 DER the custody
/// layer produced for the enrolled device identity.
pub fn pinned_connector(
    pinned_peer_spki: impl IntoIterator<Item = String>,
    client_cert_der: Vec<u8>,
    client_key_der: Vec<u8>,
) -> Result<(tokio_rustls::TlsConnector, Arc<Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = PinVerifier::new(pinned_peer_spki.into_iter().collect(), provider.clone());
    let verified_pin = verifier.verified_pin();
    let config = ClientConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| entry_error("inner_tls_config", format!("TLS 1.3 negotiation unavailable: {e}")))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_client_auth_cert(
            vec![CertificateDer::from(client_cert_der)],
            PrivateKeyDer::Pkcs8(client_key_der.into()),
        )
        .map_err(|e| entry_error("inner_tls_config", format!("Entry device credential rejected: {e}")))?;
    Ok((tokio_rustls::TlsConnector::from(Arc::new(config)), verified_pin))
}

/// Server name carried in the inner handshake — matches the TypeScript
/// `servername: "meshrix-private-endpoint"`.
pub fn inner_server_name() -> ServerName<'static> {
    ServerName::try_from("meshrix-private-endpoint").expect("constant server name is valid")
}

// ------------------------------------------------------------- server side

/// Server-side client-cert verifier: requires the peer to present a
/// certificate whose SPKI pin is in the admitted set — the mirror of
/// `PinVerifier` for the endpoint's `createInnerTlsEndpoint`.
#[derive(Debug)]
pub struct ClientPinVerifier {
    pinned: HashSet<String>,
    provider: Arc<CryptoProvider>,
    verified_pin: Arc<Mutex<Option<String>>>,
}

impl ClientPinVerifier {
    pub fn new(pinned: HashSet<String>, provider: Arc<CryptoProvider>) -> Self {
        Self { pinned, provider, verified_pin: Arc::new(Mutex::new(None)) }
    }

    pub fn verified_pin(&self) -> Arc<Mutex<Option<String>>> {
        self.verified_pin.clone()
    }
}

impl rustls::server::danger::ClientCertVerifier for ClientPinVerifier {
    fn root_hint_subjects(&self) -> &[rustls::DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> std::result::Result<rustls::server::danger::ClientCertVerified, RustlsError> {
        let pin = spki_pin_from_cert_der(end_entity.as_ref()).ok_or_else(|| {
            RustlsError::General("unparsable peer certificate".into())
        })?;
        if !self.pinned.contains(&pin) {
            return Err(RustlsError::General(
                "inner_tls_peer_unpinned: peer identity is not pinned for this endpoint".into(),
            ));
        }
        *self.verified_pin.lock().unwrap() = Some(pin);
        Ok(rustls::server::danger::ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        Err(RustlsError::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, RustlsError> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// `createInnerTlsEndpoint` — a TLS 1.3-only server acceptor requiring a
/// pinned client certificate. `server_cert_der`/`server_key_der` are the
/// endpoint's own device credential.
pub fn pinned_acceptor(
    pinned_peer_spki: impl IntoIterator<Item = String>,
    server_cert_der: Vec<u8>,
    server_key_der: Vec<u8>,
) -> Result<(tokio_rustls::TlsAcceptor, Arc<Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = ClientPinVerifier::new(pinned_peer_spki.into_iter().collect(), provider.clone());
    let verified_pin = verifier.verified_pin();
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| entry_error("inner_tls_config", format!("TLS 1.3 negotiation unavailable: {e}")))?
        .with_client_cert_verifier(Arc::new(verifier))
        .with_single_cert(
            vec![CertificateDer::from(server_cert_der)],
            PrivateKeyDer::Pkcs8(server_key_der.into()),
        )
        .map_err(|e| entry_error("inner_tls_config", format!("Endpoint credential rejected: {e}")))?;
    Ok((tokio_rustls::TlsAcceptor::from(Arc::new(config)), verified_pin))
}

/// `createInnerTlsEndpoint` — blocking variant returning the rustls
/// `ServerConfig` for a `ServerConnection` driven on a dedicated thread
/// (the endpoint's frame-duplex channel is synchronous io).
pub fn pinned_server_config(
    pinned_peer_spki: impl IntoIterator<Item = String>,
    server_cert_der: Vec<u8>,
    server_key_der: Vec<u8>,
) -> Result<(rustls::ServerConfig, Arc<Mutex<Option<String>>>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = ClientPinVerifier::new(pinned_peer_spki.into_iter().collect(), provider.clone());
    let verified_pin = verifier.verified_pin();
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| entry_error("inner_tls_config", format!("TLS 1.3 negotiation unavailable: {e}")))?
        .with_client_cert_verifier(Arc::new(verifier))
        .with_single_cert(
            vec![CertificateDer::from(server_cert_der)],
            PrivateKeyDer::Pkcs8(server_key_der.into()),
        )
        .map_err(|e| entry_error("inner_tls_config", format!("Endpoint credential rejected: {e}")))?;
    Ok((config, verified_pin))
}
