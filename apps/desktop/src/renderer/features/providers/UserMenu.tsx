import { getUserMenuItems, getWorkbenchNavigation } from "@novel-extractor/config";
import { useId, useState } from "react";

export interface UserMenuProps {
  onOpenProviderConfig: () => void;
  onOpenSettings: () => void;
}

export function UserMenu({ onOpenProviderConfig, onOpenSettings }: UserMenuProps) {
  const menuId = useId();
  const [isOpen, setOpen] = useState(false);
  const userAction = getWorkbenchNavigation().userAction;
  const userMenuItems = getUserMenuItems();

  function handleItemClick(itemId: string): void {
    if (itemId === "provider-settings") {
      onOpenProviderConfig();
    }
    if (itemId === "desktop-settings") {
      onOpenSettings();
    }
    setOpen(false);
  }

  return (
    <div className="user-menu">
      <button
        aria-controls={menuId}
        aria-expanded={isOpen}
        className="button button--user"
        onClick={() => setOpen((currentValue) => !currentValue)}
        type="button"
      >
        {userAction.label}
      </button>
      {isOpen ? (
        <div className="user-menu__popover" id={menuId}>
          {userMenuItems.map((item) => (
            <button
              className="user-menu__item"
              key={item.id}
              onClick={() => handleItemClick(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
