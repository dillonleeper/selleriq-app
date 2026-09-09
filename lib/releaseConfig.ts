export type SellerIqRelease = 'daily-dev' | 'stable-v2'

const configuredRelease = process.env.NEXT_PUBLIC_SELLERIQ_RELEASE

export const sellerIqRelease: SellerIqRelease =
  configuredRelease === 'daily-dev' ? 'daily-dev' : 'stable-v2'

export const isStableV2 = sellerIqRelease === 'stable-v2'

export const releaseFeatures = {
  profitability: !isStableV2,
  trafficConversion: !isStableV2,
  marketplaceCompare: !isStableV2,
  supplierReorder: !isStableV2,
} as const

export const releaseBrandName = isStableV2
  ? 'Merkury Dashboard v2'
  : 'SellerIQ · Daily Dev'

export const disabledStableV2Paths = ['/profitability', '/traffic', '/compare'] as const
