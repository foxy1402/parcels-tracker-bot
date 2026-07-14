export type CarrierDef = {
  /** Track123 courierCode sent to the API */
  code: string;
  /** Human-readable label shown on the button */
  label: string;
};

export const QUICK_CARRIERS: CarrierDef[] = [
  { code: "shopeeexpressvn",  label: "Shopee Express VN" },
  { code: "ghn-giao-hng-nhanh",    label: "Giao Hàng Nhanh" },
  { code: "ightk", label: "Giao Hàng Tiết Kiệm" },
  { code: "viettel-post",      label: "Viettel Post" },
  { code: "jtexpress_vn",      label: "J&T Express VN" },
  { code: "vietnam-post",           label: "Vietnam Post" },
  { code: "vietnam-ems",           label: "VietNam EMS" },
  { code: "ninjavan-vn",           label: "Ninjavan (VN)" },
  { code: "lazada",           label: "Lazada" },
  { code: "dhl",              label: "DHL" },
  { code: "fedex",            label: "FedEx" },
  { code: "ups",              label: "UPS" },
];
