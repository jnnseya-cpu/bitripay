/**
 * World mobile money operator directory. Every operator can be used through BitriPay's
 * "direct rail" (customers pay to your operator collection number with a reference and the
 * platform confirms manually, via agents, or from forwarded SMS receipts) – no operator API needed.
 * When an aggregator gateway (Flutterwave, Paystack, MTN MoMo API, M-Pesa Daraja) covers the same
 * operator, the API rail is used automatically and this rail acts as the fallback.
 */
export interface MobileMoneyOperator {
  id: string;
  name: string;
  brand: string;
  country: string;
  currency: string;
  ussd?: string;
  color: string;
}

const op = (id: string, name: string, brand: string, country: string, currency: string, color: string, ussd?: string): MobileMoneyOperator => ({ id, name, brand, country, currency, color, ussd });

const MTN = '#facc15', AIRTEL = '#ef4444', ORANGE = '#f97316', VODA = '#dc2626', SAFARICOM = '#16a34a', TIGO = '#2563eb', WAVE = '#0ea5e9', MOOV = '#1d4ed8', ECOCASH = '#15803d', OTHER = '#6366f1';

export const MOBILE_MONEY_OPERATORS: MobileMoneyOperator[] = [
  // ---- West Africa ----
  op('mtn_gh', 'MTN Mobile Money', 'MTN', 'GH', 'GHS', MTN, '*170#'), op('vodafone_gh', 'Telecel Cash (Vodafone Cash)', 'Telecel', 'GH', 'GHS', VODA, '*110#'), op('airteltigo_gh', 'AirtelTigo Money', 'AirtelTigo', 'GH', 'GHS', TIGO, '*110#'),
  op('mtn_ng', 'MTN MoMo PSB', 'MTN', 'NG', 'NGN', MTN, '*671#'), op('airtel_ng', 'Airtel SmartCash PSB', 'Airtel', 'NG', 'NGN', AIRTEL, '*939#'), op('opay_ng', 'OPay', 'OPay', 'NG', 'NGN', '#22c55e', '*955#'), op('palmpay_ng', 'PalmPay', 'PalmPay', 'NG', 'NGN', '#7c3aed'), op('paga_ng', 'Paga', 'Paga', 'NG', 'NGN', ORANGE, '*242#'),
  op('orange_ci', 'Orange Money', 'Orange', 'CI', 'XOF', ORANGE, '#144#'), op('mtn_ci', 'MTN Mobile Money', 'MTN', 'CI', 'XOF', MTN, '*133#'), op('moov_ci', 'Moov Money', 'Moov', 'CI', 'XOF', MOOV, '*155#'), op('wave_ci', 'Wave', 'Wave', 'CI', 'XOF', WAVE),
  op('orange_sn', 'Orange Money', 'Orange', 'SN', 'XOF', ORANGE, '#144#'), op('wave_sn', 'Wave', 'Wave', 'SN', 'XOF', WAVE), op('free_sn', 'Free Money', 'Free', 'SN', 'XOF', VODA, '#150#'),
  op('orange_ml', 'Orange Money', 'Orange', 'ML', 'XOF', ORANGE, '#144#'), op('moov_ml', 'Moov Money', 'Moov', 'ML', 'XOF', MOOV), op('wave_ml', 'Wave', 'Wave', 'ML', 'XOF', WAVE),
  op('orange_bf', 'Orange Money', 'Orange', 'BF', 'XOF', ORANGE, '*144#'), op('moov_bf', 'Moov Money', 'Moov', 'BF', 'XOF', MOOV, '*555#'), op('wave_bf', 'Wave', 'Wave', 'BF', 'XOF', WAVE),
  op('mtn_bj', 'MTN Mobile Money', 'MTN', 'BJ', 'XOF', MTN, '*880#'), op('moov_bj', 'Moov Money', 'Moov', 'BJ', 'XOF', MOOV, '*155#'),
  op('tmoney_tg', 'T-Money (Togocom)', 'Togocom', 'TG', 'XOF', TIGO, '*145#'), op('moov_tg', 'Moov Money (Flooz)', 'Moov', 'TG', 'XOF', MOOV, '*155#'),
  op('airtel_ne', 'Airtel Money', 'Airtel', 'NE', 'XOF', AIRTEL, '*400#'), op('orange_ne', 'Orange Money', 'Orange', 'NE', 'XOF', ORANGE), op('moov_ne', 'Moov Money', 'Moov', 'NE', 'XOF', MOOV),
  op('orange_gn', 'Orange Money', 'Orange', 'GN', 'GNF', ORANGE, '#144#'), op('mtn_gn', 'MTN Mobile Money', 'MTN', 'GN', 'GNF', MTN),
  op('orange_sl', 'Orange Money', 'Orange', 'SL', 'SLE', ORANGE, '#144#'), op('africell_sl', 'Afrimoney', 'Africell', 'SL', 'SLE', OTHER),
  op('mtn_lr', 'MTN Mobile Money (Lonestar)', 'MTN', 'LR', 'LRD', MTN, '*156#'), op('orange_lr', 'Orange Money', 'Orange', 'LR', 'LRD', ORANGE),
  op('africell_gm', 'Afrimoney', 'Africell', 'GM', 'GMD', OTHER), op('qmoney_gm', 'QMoney', 'QCell', 'GM', 'GMD', OTHER),
  op('mtn_cm', 'MTN Mobile Money', 'MTN', 'CM', 'XAF', MTN, '*126#'), op('orange_cm', 'Orange Money', 'Orange', 'CM', 'XAF', ORANGE, '#150#'),
  // ---- Central Africa ----
  op('airtel_ga', 'Airtel Money', 'Airtel', 'GA', 'XAF', AIRTEL, '*150#'), op('moov_ga', 'Moov Money', 'Moov', 'GA', 'XAF', MOOV),
  op('mtn_cg', 'MTN Mobile Money', 'MTN', 'CG', 'XAF', MTN, '*105#'), op('airtel_cg', 'Airtel Money', 'Airtel', 'CG', 'XAF', AIRTEL),
  op('airtel_td', 'Airtel Money', 'Airtel', 'TD', 'XAF', AIRTEL), op('moov_td', 'Moov Money', 'Moov', 'TD', 'XAF', MOOV),
  op('orange_cd', 'Orange Money', 'Orange', 'CD', 'CDF', ORANGE, '#144#'), op('airtel_cd', 'Airtel Money', 'Airtel', 'CD', 'CDF', AIRTEL, '*501#'), op('mpesa_cd', 'M-Pesa (Vodacom)', 'Vodacom', 'CD', 'CDF', VODA, '*1222#'), op('africell_cd', 'Afrimoney', 'Africell', 'CD', 'CDF', OTHER),
  op('orange_cf', 'Orange Money', 'Orange', 'CF', 'XAF', ORANGE), op('telecel_cf', 'Telecel Money', 'Telecel', 'CF', 'XAF', VODA),
  // ---- East Africa ----
  op('mpesa_ke', 'M-Pesa', 'Safaricom', 'KE', 'KES', SAFARICOM, '*334#'), op('airtel_ke', 'Airtel Money', 'Airtel', 'KE', 'KES', AIRTEL, '*334#'), op('tkash_ke', 'T-Kash', 'Telkom', 'KE', 'KES', TIGO),
  op('mtn_ug', 'MTN Mobile Money', 'MTN', 'UG', 'UGX', MTN, '*165#'), op('airtel_ug', 'Airtel Money', 'Airtel', 'UG', 'UGX', AIRTEL, '*185#'),
  op('mpesa_tz', 'M-Pesa (Vodacom)', 'Vodacom', 'TZ', 'TZS', VODA, '*150*00#'), op('tigo_tz', 'Mixx by Yas (Tigo Pesa)', 'Yas', 'TZ', 'TZS', TIGO, '*150*01#'), op('airtel_tz', 'Airtel Money', 'Airtel', 'TZ', 'TZS', AIRTEL, '*150*60#'), op('halopesa_tz', 'HaloPesa', 'Halotel', 'TZ', 'TZS', ORANGE, '*150*88#'),
  op('mtn_rw', 'MTN Mobile Money', 'MTN', 'RW', 'RWF', MTN, '*182#'), op('airtel_rw', 'Airtel Money', 'Airtel', 'RW', 'RWF', AIRTEL, '*500#'),
  op('ecocash_bi', 'EcoCash', 'Econet', 'BI', 'BIF', ECOCASH, '*777#'), op('lumicash_bi', 'Lumicash', 'Lumitel', 'BI', 'BIF', OTHER, '*163#'),
  op('telebirr_et', 'telebirr', 'Ethio Telecom', 'ET', 'ETB', SAFARICOM, '*127#'), op('mpesa_et', 'M-Pesa Ethiopia', 'Safaricom', 'ET', 'ETB', ECOCASH, '*733#'),
  op('evc_so', 'EVC Plus', 'Hormuud', 'SO', 'SOS', OTHER, '*770#'), op('zaad_so', 'ZAAD', 'Telesom', 'SO', 'SOS', ECOCASH), op('sahal_so', 'Sahal', 'Golis', 'SO', 'SOS', TIGO),
  op('mgurush_ss', 'm-Gurush', 'Trinity', 'SS', 'SSP', OTHER, '*344#'), op('mtn_ss', 'MTN MoMo', 'MTN', 'SS', 'SSP', MTN),
  op('mtn_sd', 'MTN Sudan Mobile Money', 'MTN', 'SD', 'SDG', MTN), op('zain_sd', 'Zain Cash', 'Zain', 'SD', 'SDG', '#7c3aed'),
  op('evatis_dj', 'D-Money', 'Djibouti Telecom', 'DJ', 'DJF', TIGO), op('waafi_dj', 'Waafi', 'Salaam', 'DJ', 'DJF', ECOCASH),
  op('mvola_mg', 'MVola', 'Telma', 'MG', 'MGA', ECOCASH, '#111#'), op('orange_mg', 'Orange Money', 'Orange', 'MG', 'MGA', ORANGE, '#144#'), op('airtel_mg', 'Airtel Money', 'Airtel', 'MG', 'MGA', AIRTEL, '*436#'),
  op('mpesa_mz', 'M-Pesa (Vodacom)', 'Vodacom', 'MZ', 'MZN', VODA, '*150#'), op('emola_mz', 'e-Mola', 'Movitel', 'MZ', 'MZN', ORANGE, '*898#'), op('mkesh_mz', 'mKesh', 'Tmcel', 'MZ', 'MZN', TIGO),
  op('airtel_mw', 'Airtel Money', 'Airtel', 'MW', 'MWK', AIRTEL, '*211#'), op('mpamba_mw', 'TNM Mpamba', 'TNM', 'MW', 'MWK', ECOCASH, '*444#'),
  op('mtn_zm', 'MTN Mobile Money', 'MTN', 'ZM', 'ZMW', MTN, '*303#'), op('airtel_zm', 'Airtel Money', 'Airtel', 'ZM', 'ZMW', AIRTEL, '*115#'), op('zamtel_zm', 'Zamtel Kwacha', 'Zamtel', 'ZM', 'ZMW', ECOCASH, '*344#'),
  op('ecocash_zw', 'EcoCash', 'Econet', 'ZW', 'ZWG', ECOCASH, '*151#'), op('onemoney_zw', 'OneMoney', 'NetOne', 'ZW', 'ZWG', TIGO, '*111#'), op('innbucks_zw', 'InnBucks', 'InnBucks', 'ZW', 'ZWG', ORANGE),
  op('orange_bw', 'Orange Money', 'Orange', 'BW', 'BWP', ORANGE, '*145#'), op('myzaka_bw', 'MyZaka (Mascom)', 'Mascom', 'BW', 'BWP', ECOCASH, '*167#'), op('smega_bw', 'Smega (BTC)', 'BTC', 'BW', 'BWP', TIGO),
  op('mpesa_ls', 'M-Pesa', 'Vodacom', 'LS', 'LSL', VODA, '*111#'), op('ecocash_ls', 'EcoCash', 'Econet', 'LS', 'LSL', ECOCASH),
  op('mtn_sz', 'MTN MoMo', 'MTN', 'SZ', 'SZL', MTN, '*007#'), op('emali_sz', 'e-Mali', 'Eswatini Mobile', 'SZ', 'SZL', TIGO),
  op('ewallet_na', 'MTC Maris / eWallet', 'MTC', 'NA', 'NAD', TIGO), op('mpesa_za', 'MTN MoMo', 'MTN', 'ZA', 'ZAR', MTN, '*120*151#'), op('vodapay_za', 'VodaPay', 'Vodacom', 'ZA', 'ZAR', VODA),
  op('mcel_ao', 'Unitel Money', 'Unitel', 'AO', 'AOA', ORANGE, '*400#'), op('africell_ao', 'Afrimoney', 'Africell', 'AO', 'AOA', OTHER),
  op('mcash_mu', 'my.t money', 'Mauritius Telecom', 'MU', 'MUR', TIGO), op('mtn_km', 'Huri Money', 'Telco SA', 'KM', 'KMF', OTHER),
  // ---- North Africa & Middle East ----
  op('vodafone_eg', 'Vodafone Cash', 'Vodafone', 'EG', 'EGP', VODA, '*9#'), op('orange_eg', 'Orange Cash', 'Orange', 'EG', 'EGP', ORANGE), op('etisalat_eg', 'e& cash (Etisalat Cash)', 'e&', 'EG', 'EGP', ECOCASH), op('we_eg', 'WE Pay', 'WE', 'EG', 'EGP', '#7c3aed'),
  op('orange_ma', 'Orange Money', 'Orange', 'MA', 'MAD', ORANGE), op('inwi_ma', 'inwi money', 'inwi', 'MA', 'MAD', '#7c3aed'), op('mtcash_ma', 'MT Cash', 'Maroc Telecom', 'MA', 'MAD', TIGO),
  op('flouci_tn', 'Flouci', 'Flouci', 'TN', 'TND', OTHER), op('d17_tn', 'D17', 'La Poste', 'TN', 'TND', TIGO),
  op('zain_jo', 'Zain Cash', 'Zain', 'JO', 'JOD', '#7c3aed'), op('orange_jo', 'Orange Money', 'Orange', 'JO', 'JOD', ORANGE), op('uwallet_jo', 'UWallet', 'Umniah', 'JO', 'JOD', ECOCASH),
  op('zain_iq', 'Zain Cash', 'Zain', 'IQ', 'IQD', '#7c3aed'), op('asiahawala_iq', 'AsiaHawala', 'Asiacell', 'IQ', 'IQD', TIGO),
  op('stcpay_sa', 'stc pay', 'stc', 'SA', 'SAR', '#7c3aed'), op('etisalat_ae', 'e& money', 'e&', 'AE', 'AED', ECOCASH),
  op('benefitpay_bh', 'BenefitPay', 'BENEFIT', 'BH', 'BHD', '#7c3aed'), op('omantel_om', 'Omantel Pay', 'Omantel', 'OM', 'OMR', TIGO),
  op('jawwal_ps', 'JawwalPay', 'Jawwal', 'PS', 'ILS', ECOCASH), op('ooredoo_qa', 'Ooredoo Money', 'Ooredoo', 'QA', 'QAR', VODA),
  op('mcash_ye', 'Floosak', 'Kuraimi', 'YE', 'YER', OTHER), op('syriatel_sy', 'Syriatel Cash', 'Syriatel', 'SY', 'SYP', VODA),
  // ---- South Asia ----
  op('bkash_bd', 'bKash', 'bKash', 'BD', 'BDT', '#e11d74', '*247#'), op('nagad_bd', 'Nagad', 'Nagad', 'BD', 'BDT', ORANGE, '*167#'), op('rocket_bd', 'Rocket', 'Dutch-Bangla Bank', 'BD', 'BDT', '#7c3aed', '*322#'), op('upay_bd', 'Upay', 'UCB', 'BD', 'BDT', TIGO),
  op('jazzcash_pk', 'JazzCash', 'Jazz', 'PK', 'PKR', VODA, '*786#'), op('easypaisa_pk', 'Easypaisa', 'Telenor', 'PK', 'PKR', ECOCASH, '*786#'), op('sadapay_pk', 'SadaPay', 'SadaPay', 'PK', 'PKR', OTHER), op('nayapay_pk', 'NayaPay', 'NayaPay', 'PK', 'PKR', TIGO),
  op('paytm_in', 'Paytm Wallet', 'Paytm', 'IN', 'INR', TIGO), op('phonepe_in', 'PhonePe (UPI)', 'PhonePe', 'IN', 'INR', '#7c3aed'), op('gpay_in', 'Google Pay (UPI)', 'Google', 'IN', 'INR', ECOCASH), op('airtel_in', 'Airtel Payments Bank', 'Airtel', 'IN', 'INR', AIRTEL), op('mobikwik_in', 'MobiKwik', 'MobiKwik', 'IN', 'INR', ORANGE),
  op('esewa_np', 'eSewa', 'eSewa', 'NP', 'NPR', ECOCASH), op('khalti_np', 'Khalti', 'Khalti', 'NP', 'NPR', '#7c3aed'), op('imepay_np', 'IME Pay', 'IME', 'NP', 'NPR', VODA),
  op('ezcash_lk', 'eZ Cash', 'Dialog', 'LK', 'LKR', ORANGE), op('mcash_lk', 'mCash', 'Mobitel', 'LK', 'LKR', ECOCASH),
  op('mpay_af', 'M-Paisa', 'Roshan', 'AF', 'AFN', VODA), op('hesabpay_af', 'HesabPay', 'Hesab', 'AF', 'AFN', TIGO),
  op('mbob_bt', 'mBoB', 'Bank of Bhutan', 'BT', 'BTN', ORANGE), op('ooredoo_mv', 'm-Faisaa', 'Ooredoo', 'MV', 'MVR', VODA), op('dhiraagu_mv', 'Dhiraagu Pay', 'Dhiraagu', 'MV', 'MVR', TIGO),
  // ---- South-East & East Asia ----
  op('gcash_ph', 'GCash', 'Globe', 'PH', 'PHP', TIGO), op('maya_ph', 'Maya (PayMaya)', 'Maya', 'PH', 'PHP', ECOCASH), op('grabpay_ph', 'GrabPay', 'Grab', 'PH', 'PHP', '#16a34a'), op('shopeepay_ph', 'ShopeePay', 'Shopee', 'PH', 'PHP', ORANGE),
  op('gopay_id', 'GoPay', 'Gojek', 'ID', 'IDR', ECOCASH), op('ovo_id', 'OVO', 'OVO', 'ID', 'IDR', '#7c3aed'), op('dana_id', 'DANA', 'DANA', 'ID', 'IDR', TIGO), op('linkaja_id', 'LinkAja', 'Telkomsel', 'ID', 'IDR', VODA), op('shopeepay_id', 'ShopeePay', 'Shopee', 'ID', 'IDR', ORANGE),
  op('tng_my', "Touch 'n Go eWallet", 'TNG', 'MY', 'MYR', TIGO), op('grabpay_my', 'GrabPay', 'Grab', 'MY', 'MYR', '#16a34a'), op('boost_my', 'Boost', 'Boost', 'MY', 'MYR', VODA), op('duitnow_my', 'DuitNow', 'PayNet', 'MY', 'MYR', '#7c3aed'),
  op('truemoney_th', 'TrueMoney Wallet', 'True', 'TH', 'THB', ORANGE), op('promptpay_th', 'PromptPay', 'BoT', 'TH', 'THB', TIGO), op('rabbit_th', 'Rabbit LINE Pay', 'LINE', 'TH', 'THB', ECOCASH),
  op('momo_vn', 'MoMo', 'M_Service', 'VN', 'VND', '#e11d74'), op('zalopay_vn', 'ZaloPay', 'Zalo', 'VN', 'VND', TIGO), op('vnpay_vn', 'VNPAY', 'VNPAY', 'VN', 'VND', VODA), op('viettel_vn', 'Viettel Money', 'Viettel', 'VN', 'VND', ECOCASH),
  op('wing_kh', 'Wing', 'Wing', 'KH', 'KHR', ECOCASH), op('aba_kh', 'ABA Pay', 'ABA', 'KH', 'KHR', TIGO), op('pipay_kh', 'Pi Pay', 'Pi Pay', 'KH', 'KHR', OTHER),
  op('bcel_la', 'BCEL One', 'BCEL', 'LA', 'LAK', VODA), op('umoney_la', 'u-money', 'Unitel', 'LA', 'LAK', ORANGE),
  op('wavemoney_mm', 'Wave Money', 'Wave', 'MM', 'MMK', MTN), op('kbzpay_mm', 'KBZPay', 'KBZ', 'MM', 'MMK', TIGO), op('ayapay_mm', 'AYA Pay', 'AYA', 'MM', 'MMK', VODA),
  op('paynow_sg', 'PayNow', 'ABS', 'SG', 'SGD', '#7c3aed'), op('grabpay_sg', 'GrabPay', 'Grab', 'SG', 'SGD', '#16a34a'),
  op('alipay_cn', 'Alipay', 'Ant Group', 'CN', 'CNY', TIGO), op('wechat_cn', 'WeChat Pay', 'Tencent', 'CN', 'CNY', ECOCASH),
  op('paypay_jp', 'PayPay', 'PayPay', 'JP', 'JPY', VODA), op('linepay_jp', 'LINE Pay', 'LINE', 'JP', 'JPY', ECOCASH), op('kakaopay_kr', 'KakaoPay', 'Kakao', 'KR', 'KRW', MTN), op('naverpay_kr', 'Naver Pay', 'Naver', 'KR', 'KRW', ECOCASH),
  op('linepay_tw', 'LINE Pay', 'LINE', 'TW', 'TWD', ECOCASH), op('jkopay_tw', 'JKOPAY', 'JKOPAY', 'TW', 'TWD', VODA), op('alipayhk_hk', 'AlipayHK', 'Alipay', 'HK', 'HKD', TIGO), op('octopus_hk', 'Octopus', 'Octopus', 'HK', 'HKD', ORANGE),
  op('digicel_pg', 'CellMoni', 'Digicel', 'PG', 'PGK', VODA), op('mpaisa_fj', 'M-PAiSA', 'Vodafone', 'FJ', 'FJD', VODA), op('mycash_fj', 'MyCash', 'Digicel', 'FJ', 'FJD', OTHER), op('digicel_ws', 'Digicel Mobile Money', 'Digicel', 'WS', 'WST', VODA), op('mvatu_vu', 'M-Vatu', 'Vodafone', 'VU', 'VUV', VODA),
  // ---- Central Asia & Caucasus ----
  op('kaspi_kz', 'Kaspi Pay', 'Kaspi', 'KZ', 'KZT', VODA), op('payme_uz', 'Payme', 'Paycom', 'UZ', 'UZS', TIGO), op('click_uz', 'Click', 'Click', 'UZ', 'UZS', ECOCASH), op('elsom_kg', 'Elsom', 'Elsom', 'KG', 'KGS', OTHER), op('alif_tj', 'Alif Mobi', 'Alif', 'TJ', 'TJS', ECOCASH), op('m1_ge', 'TBC Pay', 'TBC', 'GE', 'GEL', TIGO), op('idram_am', 'Idram', 'Idram', 'AM', 'AMD', VODA), op('mpay_az', 'm10', 'PASHA', 'AZ', 'AZN', OTHER), op('mpay_mn', 'MonPay', 'Mobicom', 'MN', 'MNT', TIGO),
  // ---- Latin America & Caribbean ----
  op('pix_br', 'Pix', 'Banco Central', 'BR', 'BRL', ECOCASH), op('mercadopago_br', 'Mercado Pago', 'Mercado Libre', 'BR', 'BRL', TIGO), op('picpay_br', 'PicPay', 'PicPay', 'BR', 'BRL', '#16a34a'),
  op('mercadopago_ar', 'Mercado Pago', 'Mercado Libre', 'AR', 'ARS', TIGO), op('uala_ar', 'Ualá', 'Ualá', 'AR', 'ARS', VODA),
  op('nequi_co', 'Nequi', 'Bancolombia', 'CO', 'COP', '#e11d74'), op('daviplata_co', 'DaviPlata', 'Davivienda', 'CO', 'COP', VODA),
  op('yape_pe', 'Yape', 'BCP', 'PE', 'PEN', '#7c3aed'), op('plin_pe', 'Plin', 'Plin', 'PE', 'PEN', TIGO),
  op('mach_cl', 'MACH', 'Bci', 'CL', 'CLP', '#7c3aed'), op('tenpo_cl', 'Tenpo', 'Tenpo', 'CL', 'CLP', VODA),
  op('mercadopago_mx', 'Mercado Pago', 'Mercado Libre', 'MX', 'MXN', TIGO), op('codi_mx', 'CoDi', 'Banxico', 'MX', 'MXN', ECOCASH), op('oxxo_mx', 'OXXO Pay', 'OXXO', 'MX', 'MXN', VODA),
  op('tigo_gt', 'Tigo Money', 'Tigo', 'GT', 'GTQ', TIGO), op('tigo_hn', 'Tigo Money', 'Tigo', 'HN', 'HNL', TIGO), op('tigo_sv', 'Tigo Money', 'Tigo', 'SV', 'USD', TIGO), op('tigo_py', 'Tigo Money', 'Tigo', 'PY', 'PYG', TIGO), op('tigo_bo', 'Tigo Money', 'Tigo', 'BO', 'BOB', TIGO), op('billetera_ni', 'Billetera Móvil', 'Claro', 'NI', 'NIO', VODA), op('yappy_pa', 'Yappy', 'Banco General', 'PA', 'PAB', TIGO), op('sinpe_cr', 'SINPE Móvil', 'BCCR', 'CR', 'CRC', ECOCASH),
  op('moncash_ht', 'MonCash', 'Digicel', 'HT', 'HTG', VODA), op('natcash_ht', 'NatCash', 'Natcom', 'HT', 'HTG', TIGO), op('tpago_do', 'tPago', 'GCS', 'DO', 'DOP', ECOCASH), op('lynk_jm', 'Lynk', 'NCB', 'JM', 'JMD', VODA), op('mmg_gy', 'MMG', 'GTT', 'GY', 'GYD', ECOCASH), op('mopi_sr', 'Mopé', 'Hakrinbank', 'SR', 'SRD', TIGO),
  op('bimo_ec', 'BIMO', 'Banred', 'EC', 'USD', ECOCASH), op('deuna_ec', 'DeUna', 'Pichincha', 'EC', 'USD', VODA), op('mercadopago_uy', 'Mercado Pago', 'Mercado Libre', 'UY', 'UYU', TIGO), op('pago_ve', 'Pago Móvil', 'BCV', 'VE', 'VES', OTHER),
  // ---- Europe & North America (instant wallet rails) ----
  op('revolut_eu', 'Revolut', 'Revolut', 'GB', 'GBP', TIGO), op('paypal_us', 'PayPal', 'PayPal', 'US', 'USD', '#1d4ed8'), op('venmo_us', 'Venmo', 'PayPal', 'US', 'USD', TIGO), op('cashapp_us', 'Cash App', 'Block', 'US', 'USD', ECOCASH), op('zelle_us', 'Zelle', 'EWS', 'US', 'USD', '#7c3aed'),
  op('interac_ca', 'Interac e-Transfer', 'Interac', 'CA', 'CAD', MTN), op('bizum_es', 'Bizum', 'Bizum', 'ES', 'EUR', ECOCASH), op('mbway_pt', 'MB WAY', 'SIBS', 'PT', 'EUR', VODA), op('swish_se', 'Swish', 'Swish', 'SE', 'SEK', OTHER), op('vipps_no', 'Vipps', 'Vipps', 'NO', 'NOK', ORANGE), op('mobilepay_dk', 'MobilePay', 'Vipps', 'DK', 'DKK', TIGO), op('twint_ch', 'TWINT', 'TWINT', 'CH', 'CHF', '#111827'), op('blik_pl', 'BLIK', 'PSP', 'PL', 'PLN', '#111827'), op('satispay_it', 'Satispay', 'Satispay', 'IT', 'EUR', VODA), op('lydia_fr', 'Lydia', 'Lydia', 'FR', 'EUR', TIGO), op('payconiq_be', 'Payconiq', 'Payconiq', 'BE', 'EUR', ECOCASH), op('tikkie_nl', 'Tikkie', 'ABN AMRO', 'NL', 'EUR', TIGO), op('papara_tr', 'Papara', 'Papara', 'TR', 'TRY', '#7c3aed'), op('sbp_ru', 'SBP', 'Bank of Russia', 'RU', 'RUB', OTHER), op('monobank_ua', 'monobank', 'monobank', 'UA', 'UAH', '#111827'),
];

export function operatorsForCountry(country?: string | null): MobileMoneyOperator[] {
  if (!country) return MOBILE_MONEY_OPERATORS;
  const c = country.toUpperCase();
  return MOBILE_MONEY_OPERATORS.filter((o) => o.country === c);
}

export const MOBILE_MONEY_BY_ID: Record<string, MobileMoneyOperator> = Object.fromEntries(MOBILE_MONEY_OPERATORS.map((o) => [o.id, o]));
