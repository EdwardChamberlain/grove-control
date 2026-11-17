# Grove Control picomatch patch

This is picomatch 4.0.7 with the single-branch repeated-extglob ReDoS fix from [micromatch/picomatch PR #237](https://github.com/micromatch/picomatch/pull/237), commit 1bf0d04563cb9ce568cf36efc5f6b7187d9911d5.

The local version is marked 4.0.8-grove.0 so the audit can distinguish this patched copy from upstream picomatch versions through 4.0.7. Replace this vendored copy with an official patched release once one is published.
