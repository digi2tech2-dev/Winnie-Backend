param(
    [string]$Token = $env:ZIINA_ACCESS_TOKEN,
    [string]$ApiBaseUrl = $(if ($env:ZIINA_API_BASE_URL) { $env:ZIINA_API_BASE_URL } else { "https://api-v2.ziina.com/api" })
)

if (-not $Token) {
    throw "Set ZIINA_ACCESS_TOKEN or pass -Token. Do not put real tokens in source control."
}

$body = @{
    amount = 200
    currency_code = "AED"
    message = "Winnie test payment"
    success_url = "https://winniefun.com/payment/success?payment_intent_id={PAYMENT_INTENT_ID}"
    cancel_url = "https://winniefun.com/payment/cancel?payment_intent_id={PAYMENT_INTENT_ID}"
    failure_url = "https://winniefun.com/payment/cancel?payment_intent_id={PAYMENT_INTENT_ID}"
    test = $true
    allow_tips = $false
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post `
    -Uri "$($ApiBaseUrl.TrimEnd('/'))/payment_intent" `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType "application/json" `
    -Body $body
