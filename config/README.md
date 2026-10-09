# Trusted product configuration

The current product accepts only native schema-5 `local-windows` profiles. Use
`npm run admit:public -- inspect <url>` followed by the interactive `approve`
or `approve-headed` operation to create a trusted configuration. The admission
CLI binds the exact approved URL to the profile reference and native profile
fingerprint. Direct Node execution and the Python UI both require that approval.

The reviewed DNS addresses and inspection digest in an approval record are
operator approval metadata. Local Chromium does not enforce DNS pins or an
egress proxy. Old schema-3/4 and Docker configuration files are unsupported.
