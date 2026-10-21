/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MozAIProtocolHandler.h"

#include "RemoteStreamGetter.h"
#include "SimpleChannel.h"
#include "mozilla/ClearOnShutdown.h"
#include "nsICancelable.h"
#include "nsIInputStreamPump.h"
#include "nsIMozAIStreamProvider.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"

#define MOZ_AI_SCHEME "moz-ai"

namespace mozilla::net {

namespace {

/**
 * Asks the nsIMozAIStreamProvider for the content of a moz-ai URI and pumps
 * it into the listener of the SimpleChannel.
 */
class MozAIStreamGetter final : public nsICancelable,
                                public nsIMozAIStreamCallback {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICANCELABLE
  NS_DECL_NSIMOZAISTREAMCALLBACK

  explicit MozAIStreamGetter(nsIURI* aURI) : mURI(aURI) {}

  RequestOrReason GetAsync(nsIStreamListener* aListener, nsIChannel* aChannel);

 private:
  ~MozAIStreamGetter() = default;

  nsCOMPtr<nsIURI> mURI;
  nsCOMPtr<nsIStreamListener> mListener;
  nsCOMPtr<nsIChannel> mChannel;
  nsCOMPtr<nsIInputStreamPump> mPump;
  bool mCanceled = false;
  nsresult mStatus = NS_OK;
};

NS_IMPL_ISUPPORTS(MozAIStreamGetter, nsICancelable, nsIMozAIStreamCallback)

RequestOrReason MozAIStreamGetter::GetAsync(nsIStreamListener* aListener,
                                            nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());

  nsCOMPtr<nsIMozAIStreamProvider> provider =
      do_GetService(MOZ_AI_STREAM_PROVIDER_CONTRACTID);
  if (!provider) {
    return Err(NS_ERROR_NOT_AVAILABLE);
  }

  mListener = aListener;
  mChannel = aChannel;

  nsresult rv = provider->GetStream(mURI, this);
  if (NS_FAILED(rv)) {
    mListener = nullptr;
    mChannel = nullptr;
    return Err(rv);
  }

  nsCOMPtr<nsICancelable> cancelable(this);
  return RequestOrCancelable(WrapNotNull(cancelable));
}

NS_IMETHODIMP
MozAIStreamGetter::Cancel(nsresult aStatus) {
  if (mCanceled) {
    return NS_OK;
  }

  mCanceled = true;
  mStatus = aStatus;

  if (mPump) {
    mPump->Cancel(aStatus);
    mPump = nullptr;
  }

  return NS_OK;
}

NS_IMETHODIMP
MozAIStreamGetter::OnStream(nsIInputStream* aStream,
                            const nsACString& aContentType,
                            int64_t aContentLength) {
  MOZ_ASSERT(NS_IsMainThread());

  if (!mChannel) {
    return NS_ERROR_UNEXPECTED;
  }

  nsCOMPtr<nsIChannel> channel = std::move(mChannel);
  nsCOMPtr<nsIStreamListener> listener = std::move(mListener);

  if (mCanceled) {
    RemoteStreamGetter::CancelRequest(listener, channel, mStatus);
    return NS_OK;
  }

  if (!aStream) {
    RemoteStreamGetter::CancelRequest(listener, channel,
                                      NS_ERROR_FILE_NOT_FOUND);
    return NS_OK;
  }

  nsCOMPtr<nsIInputStreamPump> pump;
  nsresult rv =
      NS_NewInputStreamPump(getter_AddRefs(pump), do_AddRef(aStream), 0, 0,
                            false, GetMainThreadSerialEventTarget());
  if (NS_FAILED(rv)) {
    RemoteStreamGetter::CancelRequest(listener, channel, rv);
    return NS_OK;
  }

  channel->SetContentType(aContentType);
  channel->SetContentLength(aContentLength);

  rv = pump->AsyncRead(listener);
  if (NS_FAILED(rv)) {
    RemoteStreamGetter::CancelRequest(listener, channel, rv);
    return NS_OK;
  }

  mPump = std::move(pump);
  return NS_OK;
}

NS_IMETHODIMP
MozAIStreamGetter::OnError(nsresult aStatus) {
  MOZ_ASSERT(NS_IsMainThread());

  if (!mChannel) {
    return NS_ERROR_UNEXPECTED;
  }

  nsCOMPtr<nsIChannel> channel = std::move(mChannel);
  nsCOMPtr<nsIStreamListener> listener = std::move(mListener);

  RemoteStreamGetter::CancelRequest(
      listener, channel,
      mCanceled ? mStatus
                : (NS_FAILED(aStatus) ? aStatus : NS_ERROR_FILE_NOT_FOUND));
  return NS_OK;
}

}  // namespace

StaticRefPtr<MozAIProtocolHandler> MozAIProtocolHandler::sSingleton;

NS_IMPL_ISUPPORTS(MozAIProtocolHandler, nsIProtocolHandler)

already_AddRefed<MozAIProtocolHandler> MozAIProtocolHandler::GetSingleton() {
  if (!sSingleton) {
    sSingleton = new MozAIProtocolHandler();
    ClearOnShutdown(&sSingleton);
  }

  return do_AddRef(sSingleton);
}

NS_IMETHODIMP
MozAIProtocolHandler::GetScheme(nsACString& aResult) {
  aResult.AssignLiteral(MOZ_AI_SCHEME);
  return NS_OK;
}

NS_IMETHODIMP
MozAIProtocolHandler::NewChannel(nsIURI* aURI, nsILoadInfo* aLoadInfo,
                                 nsIChannel** aRetVal) {
  NS_ENSURE_ARG_POINTER(aURI);
  NS_ENSURE_ARG_POINTER(aLoadInfo);

  if (!NS_IsMainThread()) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsAutoCString host;
  if (NS_FAILED(aURI->GetAsciiHost(host)) || host.IsEmpty()) {
    return NS_ERROR_MALFORMED_URI;
  }

  RefPtr<MozAIStreamGetter> getter = new MozAIStreamGetter(aURI);

  nsCOMPtr<nsIChannel> channel =
      NS_NewSimpleChannel(aURI, aLoadInfo, getter.get(),
                          [](nsIStreamListener* aListener, nsIChannel* aChannel,
                             MozAIStreamGetter* aGetter) -> RequestOrReason {
                            return aGetter->GetAsync(aListener, aChannel);
                          });

  channel.forget(aRetVal);
  return NS_OK;
}

NS_IMETHODIMP
MozAIProtocolHandler::AllowPort(int32_t aPort, const char* aScheme,
                                bool* aRetVal) {
  *aRetVal = false;
  return NS_OK;
}

}  // namespace mozilla::net
