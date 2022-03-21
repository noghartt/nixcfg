-- TODO: Move it to correctly place
import XMonad

import qualified XMonad.StackSet as W

import XMonad.Layout.BoringWindows
import XMonad.Layout.Fullscreen
import XMonad.Layout.Grid
import XMonad.Layout.Groups
import XMonad.Layout.MultiColumns
import XMonad.Layout.NoBorders
import XMonad.Layout.SubLayouts
import XMonad.Layout.Tabbed
import XMonad.Layout.ThreeColumns
import XMonad.Layout.WindowNavigation

import XMonad.Hooks.EwmhDesktops

import XMonad.Util.EZConfig

main :: IO ()
main = xmonad
     $ fullscreenSupport
     $ flip removeKeys     keysToRemove
     . flip additionalKeys keysToAdd
     $ ewmh def
       { modMask     = myMod
       , terminal    = myTerminal
       , borderWidth = myBorderWidth
       , layoutHook  = myLayout
       }

-- KEYBINDING
keysToRemove =
  [ (myMod, xK_p)
  ]

keysToAdd = generalKeys ++ subLayoutKeys

generalKeys =
  [ ((myMod, xK_d)              , spawn "dmenu_run -b")
  , ((myMod .|. shiftMask, xK_r), spawn "xmonad --recompile; xmonad --restart")
  , ((0, xK_Print)              , spawn "flameshot gui")
  ]

subLayoutKeys =
  [ ((myMod .|. controlMask, xK_h),      sendMessage $ pullGroup L)
  , ((myMod .|. controlMask, xK_j),      sendMessage $ pullGroup D)
  , ((myMod .|. controlMask, xK_k),      sendMessage $ pullGroup U)
  , ((myMod .|. controlMask, xK_l),      sendMessage $ pullGroup R)
  , ((myMod .|. controlMask, xK_m),      withFocused (sendMessage . MergeAll))
  , ((myMod .|. controlMask, xK_u),      withFocused (sendMessage . UnMerge))
  , ((myMod .|. controlMask, xK_period), onGroup W.focusUp')
  , ((myMod .|. controlMask, xK_comma),  onGroup W.focusDown')
  , ((myMod .|. controlMask, xK_space),  toSubl NextLayout)
  ]

-- LAYOUT
myLayout = windowNavigation $ boringWindows $ smartBorders $
                addTabs shrinkText def
                $ subLayout [0] (Tall 1 (3/100) 0.5 ||| Grid ||| Full)
                $ Tall 1 (3/100) 0.5 ||| Full

-- VARIABLES
myMod         = mod4Mask
myTerminal    = "alacritty"
myBorderWidth = 0
