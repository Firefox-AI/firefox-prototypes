/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef MozAIProtocolHandler_h_
#define MozAIProtocolHandler_h_

#include "mozilla/StaticPtr.h"
#include "nsIProtocolHandler.h"

namespace mozilla::net {

/**
 * Handler for moz-ai://<context-id>/<path> URIs. The content is provided by
 * the nsIMozAIStreamProvider service of the process creating the channel.
 * Channels are SimpleChannels so that documents can be loaded in content
 * processes.
 */
class MozAIProtocolHandler final : public nsIProtocolHandler {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIPROTOCOLHANDLER

  static already_AddRefed<MozAIProtocolHandler> GetSingleton();

 private:
  MozAIProtocolHandler() = default;
  ~MozAIProtocolHandler() = default;

  static StaticRefPtr<MozAIProtocolHandler> sSingleton;
};

}  // namespace mozilla::net

#endif  // MozAIProtocolHandler_h_
