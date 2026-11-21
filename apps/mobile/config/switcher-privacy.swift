  private var privacyCover: UIView?

  override func sceneWillResignActive(_ scene: UIScene) {
    showPrivacyCover()
    super.sceneWillResignActive(scene)
  }

  override func sceneDidEnterBackground(_ scene: UIScene) {
    showPrivacyCover()
    super.sceneDidEnterBackground(scene)
  }

  override func sceneDidBecomeActive(_ scene: UIScene) {
    removePrivacyCover()
    super.sceneDidBecomeActive(scene)
  }

  override func sceneDidDisconnect(_ scene: UIScene) {
    removePrivacyCover()
    super.sceneDidDisconnect(scene)
  }

  private func showPrivacyCover() {
    guard let window else { return }
    // Put the cover above the whole window, including presented sheets.
    // UIKit can snapshot it as soon as the lifecycle callback returns.
    UIView.performWithoutAnimation {
      if let privacyCover {
        window.bringSubviewToFront(privacyCover)
        return
      }

      let cover = UIView(frame: window.bounds)
      cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      cover.isOpaque = true
      cover.backgroundColor = UIColor { traits in
        // Match the mobile theme's background in both appearances.
        traits.userInterfaceStyle == .dark
          ? UIColor(red: 16.0 / 255, green: 17.0 / 255, blue: 18.0 / 255, alpha: 1)
          : .white
      }

      let mark = UIImageView(image: UIImage(named: "PrivacyMark"))
      mark.translatesAutoresizingMaskIntoConstraints = false
      mark.contentMode = .scaleAspectFit
      mark.layer.cornerRadius = 16
      mark.clipsToBounds = true
      cover.addSubview(mark)
      NSLayoutConstraint.activate([
        mark.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
        mark.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
        mark.widthAnchor.constraint(equalToConstant: 56),
        mark.heightAnchor.constraint(equalToConstant: 56),
      ])

      window.addSubview(cover)
      cover.layoutIfNeeded()
      privacyCover = cover
    }
  }

  private func removePrivacyCover() {
    privacyCover?.removeFromSuperview()
    privacyCover = nil
  }

#if targetEnvironment(simulator)
  override var initialProperties: [AnyHashable: Any]? {
    let args = ProcessInfo.processInfo.arguments
    guard let flag = args.firstIndex(of: "-ClawtrateSwitcherProbePort"),
          args.indices.contains(flag + 1), let port = UInt16(args[flag + 1]), port > 0 else {
      return super.initialProperties
    }
    var properties = super.initialProperties ?? [:]
    properties["switcherProbePort"] = Int(port)
    return properties
  }
#endif
