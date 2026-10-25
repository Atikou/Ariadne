function New-SmokeProviderCertificate {
  param(
    [Parameter(Mandatory = $true)][string]$PfxPath,
    [Parameter(Mandatory = $true)][string]$CertificatePath,
    [Parameter(Mandatory = $true)][string]$Passphrase
  )

  $rsa = [Security.Cryptography.RSA]::Create(2048)
  try {
    $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new(
      "CN=localhost",
      $rsa,
      [Security.Cryptography.HashAlgorithmName]::SHA256,
      [Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName("localhost")
    $san.AddIpAddress([Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
    )
    $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature `
      -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true)
    )
    $oids = [Security.Cryptography.OidCollection]::new()
    [void]$oids.Add([Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.1"))
    $request.CertificateExtensions.Add(
      [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
    )
    $certificate = $request.CreateSelfSigned(
      [DateTimeOffset]::UtcNow.AddMinutes(-5),
      [DateTimeOffset]::UtcNow.AddDays(2)
    )
    try {
      [IO.File]::WriteAllBytes(
        $PfxPath,
        $certificate.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $Passphrase)
      )
      $certificateBytes = $certificate.Export(
        [Security.Cryptography.X509Certificates.X509ContentType]::Cert
      )
      $certificatePem = "-----BEGIN CERTIFICATE-----`n" `
        + [Convert]::ToBase64String($certificateBytes, [Base64FormattingOptions]::InsertLineBreaks) `
        + "`n-----END CERTIFICATE-----`n"
      [IO.File]::WriteAllText(
        $CertificatePath,
        $certificatePem,
        [Text.UTF8Encoding]::new($false)
      )
    }
    finally {
      $certificate.Dispose()
    }
  }
  finally {
    $rsa.Dispose()
  }
}
